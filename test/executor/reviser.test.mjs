import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviser, runRevision, revisionMessage, reviserTools, loadRevisionPrompt } from "../../dist/src/executor/reviser.mjs";
import { inspectRevision } from "../../dist/src/state-machine/workflow-revision.mjs";

const node = (name, step, type, params, blanks = []) => ({ name, step, type, params, blanks, note: "已有选择。" });
const context = () => {
  const steps = [
    { ref: "s1", title: "读文件", intent: "读取合同", input: "目录", output: "文件", dependsOn: [] },
    { ref: "s2", title: "提取文本", intent: "读取文字", input: "文件", output: "文本", dependsOn: ["s1"] },
    { ref: "s3", title: "抽取金额", intent: "形成金额记录", input: "文本", output: "每份合同一条 amount 数值记录，金额单位为元", dependsOn: ["s2"] },
    { ref: "s4", title: "保留记录", intent: "原样保留", input: "amount 数值记录，金额单位为元", output: "原样的 amount 数值记录", dependsOn: ["s3"] },
    { ref: "s5", title: "格式化结果", intent: "生成报表行", input: "amount 数值记录", output: "报表金额 total，以元展示两位小数", dependsOn: ["s4"] },
  ];
  return {
    plan: { readiness: "ready", goal: "读取合同金额生成报表", understanding: [{ ref: "u1", quote: "金额报表", reading: "保留金额" }], steps, openQuestions: [] },
    canvas: {
      version: 9,
      nodes: [
        node("读合同", "s1", "readFile", { folder: "/confirmed/contracts", pattern: "*.pdf" }),
        node("取文字", "s2", "parseDocument", {}),
        node("抽取金额", "s3", "llm", { prompt: "抽取以元计的 amount: {{ input.text }}", outputSchema: { type: "object", properties: { amount: { type: "number" } } } }),
        node("保留记录", "s4", "code", { code: "return items;", outputKind: "JSON" }),
        node("格式化报表", "s5", "code", { code: "return items.map(item => ({ ...item, total: item.amount.toFixed(2) }));", outputKind: "JSON" }),
      ],
      edges: [
        { from: "读合同", to: "取文字" }, { from: "取文字", to: "抽取金额" },
        { from: "抽取金额", to: "保留记录" }, { from: "保留记录", to: "格式化报表" },
      ],
    },
    target: { node: "抽取金额", step: "s3" },
    instruction: { id: "instruction-2", text: "金额改为整数分 amountCents，最终报表仍按元展示。" },
    requirements: [{ target: { node: "格式化报表", step: "s5" }, text: "报表金额保留两位小数。" }],
    annotations: [{ step: "s1", text: "保留已选目录。" }],
    history: { runs: [{ id: "run-1", status: "finished" }], edits: [{ id: "edit-1", summary: "确认报表精度。" }] },
  };
};
const review = (ctx) => ctx.plan.steps.map((step) => ({ step: step.ref, summary: ["s3", "s5"].includes(step.ref) ? "更新金额字段的生产或读取。" : "当前要求不改变本步的数据与连接。" }));
const patch = (ctx) => ({
  kind: "patch", summary: "S3 改为整数分，S5 读取新字段并转换为元；S4 保持原样。", review: review(ctx),
  upsertNodes: [
    { ...ctx.canvas.nodes[2], params: { prompt: "抽取以整数分计的 amountCents: {{ input.text }}", outputSchema: { type: "object", properties: { amountCents: { type: "integer" } } } } },
    { ...ctx.canvas.nodes[4], params: { code: "return items.map(item => ({ ...item, total: (item.amountCents / 100).toFixed(2) }));", outputKind: "JSON" } },
  ],
  removeNodes: [], addEdges: [], removeEdges: [],
});
const call = (name, args, id = "r1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const assistant = (...calls) => ({ role: "assistant", content: null, tool_calls: calls });
const scripted = (replies) => {
  const seen = [];
  const callModel = async (messages, options) => {
    seen.push({ messages: structuredClone(messages), tools: options.tools, signal: options.signal });
    assert.ok(replies.length, "模型剧本不能提前耗尽");
    return structuredClone(replies.shift());
  };
  return { callModel, seen };
};
const tempSave = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reviser-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, "01", file), "utf8"));

test("修订上下文完整序列化:目标是 S3,仍包括所有步骤、最新全图、已有要求和历史", () => {
  const ctx = context();
  const text = revisionMessage(ctx);
  for (const key of ["plan", "canvas", "target", "instruction", "requirements", "annotations", "history"]) {
    const block = text.match(new RegExp(`<${key}>\\n([\\s\\S]*?)\\n</${key}>`));
    assert.ok(block, key);
    assert.deepEqual(JSON.parse(block[1]), ctx[key]);
  }
});

test("唯一工具是整图修订;提示词常驻全节点表并区分影响判断与机器证明", () => {
  assert.deepEqual(reviserTools.map((tool) => tool.function.name), ["submit_revision"]);
  const prompt = loadRevisionPrompt();
  assert.doesNotMatch(prompt, /\{\{node_table\}\}/);
  for (const type of ["readFile", "llm", "code", "condition", "writeVectorStore"]) assert.match(prompt, new RegExp(`^- ${type} \\(`, "m"));
  assert.match(prompt, /S3 may require changing S5/);
  assert.match(prompt, /not proof/);
});

test("方案仍写 amount 元时也可按指令改为整数分并连带改 S5,保留最终单位、S4 与目录", async () => {
  const ctx = context();
  const before = structuredClone(ctx);
  const wanted = patch(ctx);
  const { callModel, seen } = scripted([assistant(call("submit_revision", wanted))]);
  const out = await runRevision(ctx, { callModel });
  assert.deepEqual(out.result, wanted);
  assert.deepEqual(out.result.upsertNodes.map((node) => node.step), ["s3", "s5"]);
  assert.deepEqual(seen[0].tools, reviserTools);
  assert.deepEqual(ctx, before);
  assert.equal(out.rounds, 1);
  assert.equal(out.timing.status, "accepted");
  assert.ok(out.timing.durationMs >= 0);
  const checked = inspectRevision(out.result, ctx);
  assert.deepEqual(checked.reasons, []);
  assert.deepEqual(checked.candidate.nodes[0], before.canvas.nodes[0]);
  assert.deepEqual(checked.candidate.nodes[3], before.canvas.nodes[3]);
  assert.deepEqual(ctx.plan, before.plan, "更改中间字段与单位不修改计划结构或旧措辞");
  // 在合成数据上比较最终展示:中间单位可以变,用户要的报表单位和精度保持不变。
  const previousRows = new Function("items", before.canvas.nodes[4].params.code)([{ amount: 123.45 }]);
  const revisedRows = new Function("items", checked.candidate.nodes[4].params.code)([{ amountCents: 12345 }]);
  assert.equal(revisedRows[0].total, previousRows[0].total);
  assert.equal(revisedRows[0].total, "123.45");
  assert.deepEqual(JSON.parse(out.messages.at(-1).content), { accepted: true, committed: false, kind: "patch" });
});

test("同一闸门退回具体原因,重试仍以原始全图为基础且需覆盖全计划 review", async () => {
  const ctx = context();
  const invalid = patch(ctx);
  invalid.review = invalid.review.slice(0, 3);
  const badSlot = patch(ctx);
  badSlot.upsertNodes[0].params.temperature = 0.2;
  const { callModel, seen } = scripted([
    assistant(call("submit_revision", invalid)),
    assistant(call("submit_revision", badSlot, "r2")),
    assistant(call("submit_revision", patch(ctx), "r3")),
  ]);
  const out = await runRevision(ctx, { callModel });
  assert.equal(out.rounds, 3);
  assert.match(JSON.parse(seen[1].messages.at(-1).content).rejected.join(";"), /s5/);
  assert.match(JSON.parse(seen[2].messages.at(-1).content).rejected.join(";"), /temperature/);
  assert.equal(seen[2].messages[1].content, revisionMessage(ctx));
  assert.equal(ctx.canvas.version, 9);
});

test("无调用、正文假调用、错工具、坏 JSON、多调用均明确退回且不误收", async () => {
  const ctx = context();
  const broken = call("submit_revision", {});
  broken.function.arguments = "{broken";
  const { callModel, seen } = scripted([
    { role: "assistant", content: "正在考虑。" },
    { role: "assistant", content: "submit_revision({kind: 'unchanged'})" },
    assistant(call("submit_step", { kind: "covered" }, "r3")),
    assistant(broken),
    assistant(call("submit_revision", patch(ctx), "r5"), call("submit_revision", patch(ctx), "r6")),
    assistant(call("submit_revision", patch(ctx), "r7")),
  ]);
  const out = await runRevision(ctx, { callModel });
  assert.equal(out.rounds, 6);
  assert.match(seen[1].messages.at(-1).content, /没有调用工具/);
  assert.match(seen[2].messages.at(-1).content, /写在正文里.*没有被收到/);
  assert.match(JSON.parse(seen[3].messages.at(-1).content).error, /unknown tool submit_step/);
  assert.match(JSON.parse(seen[4].messages.at(-1).content).error, /not valid JSON/);
  assert.deepEqual(seen[5].messages.slice(-2).map((m) => m.tool_call_id), ["r5", "r6"]);
  assert.equal(out.events.filter((event) => event.kind === "submitted").length, 1);
});

test("unchanged 与 needs_plan 只返回说明,不能夹带画布改动", async () => {
  const ctx = context();
  for (const kind of ["unchanged", "needs_plan"]) {
    const result = { kind, summary: kind === "unchanged" ? "现有字段已经符合要求。" : "必须改变计划步骤,需要先改方案。", review: review(ctx) };
    const { callModel } = scripted([
      assistant(call("submit_revision", { ...result, upsertNodes: patch(ctx).upsertNodes })),
      assistant(call("submit_revision", result, "r2")),
    ]);
    const revise = createReviser({ callModel });
    assert.deepEqual(await revise(ctx), result);
  }
});

test("成功实录保留完整上下文、消息、用时;多个请求目录彼此独立", async (t) => {
  const save = tempSave(t);
  const ctx = context();
  const wanted = patch(ctx);
  const { callModel } = scripted([assistant(call("submit_revision", wanted)), assistant(call("submit_revision", wanted))]);
  const events = [];
  const revise = createReviser({ callModel, save, onEvent: (event, on) => events.push([event.kind, on.target, on.requirements]) });
  await revise(ctx);
  await revise(ctx);
  assert.deepEqual(readdirSync(save), ["01", "02"]);
  assert.deepEqual(readJson(save, "context.json"), ctx);
  assert.deepEqual(readJson(save, "submission.json"), wanted);
  assert.equal(readJson(save, "timing.json").status, "accepted");
  assert.ok(readJson(save, "timing.json").durationMs >= 0);
  assert.deepEqual(events[0], ["submitted", ctx.target, ctx.requirements]);
});

test("接口错误也保留上下文、消息、错误和用时", async (t) => {
  const save = tempSave(t);
  const revise = createReviser({ save, callModel: async () => { throw new Error("模型接口返回 503"); } });
  await assert.rejects(revise(context()), (error) => {
    assert.match(error.message, /503/);
    assert.equal(error.messages.length, 2);
    assert.equal(error.timing.status, "failed");
    return true;
  });
  assert.equal(readJson(save, "messages.json").length, 2);
  assert.equal(readJson(save, "timing.json").status, "failed");
  assert.match(readFileSync(join(save, "01", "error.txt"), "utf8"), /503/);
});

test("达到重试上限仍保留具体拒绝原因,没有成功候选", async () => {
  const ctx = context();
  const invalid = { ...patch(ctx), review: [] };
  const { callModel } = scripted([assistant(call("submit_revision", invalid)), assistant(call("submit_revision", invalid, "r2"))]);
  await assert.rejects(runRevision(ctx, { callModel, maxRounds: 2 }), (error) => {
    assert.match(error.message, /来回 2 次.*画布未改变/);
    assert.equal(error.events.filter((event) => event.kind === "rejected").length, 2);
    assert.equal(error.timing.rounds, 2);
    assert.equal(error.timing.status, "failed");
    return true;
  });
});

test("已停止的修订不调用模型", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runRevision(context(), { callModel: async () => assert.fail("不应调用模型"), signal: controller.signal }), { name: "AbortError" });
});

test("模型忽略停止而晚到成功候选,仍拒绝返回并保存停止实录", async (t) => {
  const save = tempSave(t);
  const controller = new AbortController();
  const ctx = context();
  const revise = createReviser({
    save,
    callModel: async () => { controller.abort("用户停止"); return assistant(call("submit_revision", patch(ctx))); },
  });
  await assert.rejects(revise(ctx, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(readJson(save, "messages.json").length, 3);
  assert.equal(readJson(save, "events.json").some((event) => event.kind === "submitted"), false);
  assert.equal(readJson(save, "timing.json").status, "stopped");
  assert.ok(!readdirSync(join(save, "01")).includes("submission.json"));
});

test("校验后才收到停止也不能返回成功", async () => {
  const controller = new AbortController();
  const ctx = context();
  const { callModel } = scripted([assistant(call("submit_revision", patch(ctx)))]);
  const revise = createReviser({ callModel, onEvent: (event) => { if (event.kind === "submitted") controller.abort(); } });
  await assert.rejects(revise(ctx, { signal: controller.signal }), { name: "AbortError" });
});

test("默认修订插口延迟读模型配置", async () => {
  const mod = await import("../../dist/src/executor/reviser.mjs");
  assert.equal(typeof mod.default, "function");
});
