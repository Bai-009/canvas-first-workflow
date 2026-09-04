import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepMessage, toPatch, runStep, createExecutor, executorTools, loadSystemPrompt } from "../../src/executor/executor.mjs";

const context = (overrides = {}) => ({
  plan: { goal: "每天把新合同写进库", steps: [{ ref: "s1", title: "读文件", dependsOn: [] }], openQuestions: [] },
  step: { ref: "s1", title: "读文件", intent: "读出昨天的 PDF", input: "磁盘上的 PDF", output: "PDF 清单", dependsOn: [] },
  canvas: { nodes: [], edges: [], version: 0 },
  openQuestions: [],
  instructions: [],
  ...overrides,
});

const call = (name, args, id = "c1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const assistant = (calls, content = null) => ({ role: "assistant", content, tool_calls: calls });

/* 照剧本答的模型:每次调用弹一条回复,顺便记下它看到的整段对话 */
function scripted(replies) {
  const seen = [];
  const callModel = async (messages) => {
    seen.push(messages.map((m) => m.role));
    const next = replies.shift();
    if (!next) throw new Error("剧本演完了");
    return structuredClone(next);
  };
  return { callModel, seen };
}

test("五样贴标签,画布上的节点原样发给模型,名字就叫 name", () => {
  const text = stepMessage(context({ canvas: { nodes: [{ name: "读 PDF", step: "s1", type: "x", params: {}, blanks: [] }], edges: [], version: 1 } }));
  for (const tag of ["plan", "step", "canvas", "open_questions", "annotations"]) assert.match(text, new RegExp(`<${tag}>[\\s\\S]*</${tag}>`));
  assert.match(text, /"name": "读 PDF"/);
  assert.doesNotMatch(text, /"id":/);
});

test("模型交的换成状态机认的:只补 step,其余原样带过去,出口留着", () => {
  const patch = toPatch({ kind: "patch", nodes: [{ name: "A", type: "t", params: {}, blanks: ["x"] }], edges: [{ from: "U", to: "A" }, { from: "A", to: "B", output: "false" }] }, "s2");
  assert.deepEqual(patch.nodes, [{ name: "A", step: "s2", type: "t", params: {}, blanks: ["x"] }]);
  assert.deepEqual(patch.edges, [{ from: "U", to: "A" }, { from: "A", to: "B", output: "false" }]);
  assert.deepEqual(toPatch({ kind: "covered", nodes: [{ name: "留着" }] }, "s2"), { kind: "covered" });
});

/* 路过的层不许挑格子:契约上加一格,中间一行代码都不用改,它自己就能走到画布。
   这条钉住的是架构,不是某个字段——note 之前就是死在这儿的。 */
test("契约上新加的格子原样穿过执行器,不用改中间层", () => {
  const patch = toPatch({ kind: "patch", nodes: [{ name: "A", type: "t", params: {}, blanks: [], note: "为什么这么接", 将来新加的: 1 }], edges: [] }, "s2");
  assert.deepEqual(patch.nodes[0], { name: "A", step: "s2", type: "t", params: {}, blanks: [], note: "为什么这么接", 将来新加的: 1 });
});

test("一步的来回:交,过闸门就还回去;提示词里常驻整张节点表,只有一个工具", async () => {
  const submission = {
    kind: "patch",
    nodes: [
      { name: "Every day", type: "schedule", params: {}, blanks: [] },
      { name: "Read PDFs", type: "readFile", params: { pattern: "*.pdf" }, blanks: ["folder"], note: "目录是你的。" },
    ],
    edges: [{ from: "Every day", to: "Read PDFs" }],
  };
  const { callModel, seen } = scripted([assistant([call("submit_step", submission)])]);
  const events = [];
  const out = await runStep(context(), { callModel, systemPrompt: "P", onEvent: (e) => events.push(e.kind) });
  assert.equal(out.rounds, 1);
  assert.deepEqual(seen[0], ["system", "user"]);
  assert.deepEqual(events, ["submitted"]);
  assert.deepEqual(out.result.nodes.map((n) => [n.name, n.step]), [["Every day", "s1"], ["Read PDFs", "s1"]]);
  assert.deepEqual(out.submission, submission);
  assert.deepEqual(executorTools.map((t) => t.function.name), ["submit_step"]);
  const prompt = loadSystemPrompt();
  assert.doesNotMatch(prompt, /\{\{node_table\}\}/);
  for (const type of ["schedule", "readFile", "parseDocument", "ocr", "splitText", "embedText", "writeVectorStore", "llm", "writeDatabase", "condition", "code"]) {
    assert.match(prompt, new RegExp(`^- ${type} \\(`, "m"));
  }
  assert.match(prompt, /folder \(Folder\): the user's/);
  assert.ok(prompt.indexOf("- schedule (") < prompt.indexOf("- readFile (") && prompt.indexOf("- readFile (") < prompt.indexOf("- code ("), "表按链的顺序摆");
  assert.match(prompt, /outputs: true, false/);
});

test("闸门不认的交回,原因退给模型,它再交", async () => {
  const bad = { kind: "patch", nodes: [{ name: "A", type: "code", params: "not an object", blanks: [] }], edges: [] };
  const good = { kind: "patch", nodes: [{ name: "A", type: "code", params: { code: "// a" }, blanks: [] }], edges: [] };
  const { callModel } = scripted([assistant([call("submit_step", bad)]), assistant([call("submit_step", good, "c2")])]);
  const out = await runStep(context(), { callModel, systemPrompt: "P" });
  assert.equal(out.rounds, 2);
  const rejection = JSON.parse(out.messages[3].content);
  assert.match(rejection.rejected.join(";"), /params/);
  assert.deepEqual(out.result.nodes, [{ name: "A", step: "s1", type: "code", params: { code: "// a" }, blanks: [] }]);
});

/* 闸门只有一道,但有两处在调:执行者自己这一道,和状态机那一道。
   两处查得不一样,自己这关过了、到状态机才被退,而那时候它已经没机会改了。
   「接在谁后面」这一条就漏过一次:执行者拿不到 dependsOn,状态机拿得到。 */
test("接在上一步后面却不接线:执行者自己这一道就退回去,同一个来回里改了再交", async () => {
  const on = context({
    step: { ref: "s2", title: "切块", dependsOn: ["s1"] },
    canvas: { nodes: [{ name: "读文件", step: "s1", type: "readFile", params: {}, blanks: [] }], edges: [], version: 1 },
  });
  const loose = { kind: "patch", nodes: [{ name: "切块", type: "code", params: { code: "// x" }, blanks: [] }], edges: [] };
  const wired = { ...loose, edges: [{ from: "读文件", to: "切块" }] };
  const { callModel } = scripted([
    assistant([call("submit_step", loose)]),
    assistant([call("submit_step", wired, "c2")]),
  ]);
  const out = await runStep(on, { callModel, systemPrompt: "P" });
  assert.equal(out.rounds, 2);
  const rejection = JSON.parse(out.messages[3].content);
  assert.match(rejection.rejected.join(";"), /s2 接在 s1 后面,却没有一条线从那几步的节点接进来/);
  assert.deepEqual(out.result.edges, [{ from: "读文件", to: "切块" }]);
});

test("叫了没有的工具(搜、查都撤了),当答案退给模型,来回继续", async () => {
  const { callModel } = scripted([
    assistant([call("search_nodes", { query: "ocr" })]),
    assistant([call("submit_step", { kind: "covered" }, "c2")], "nothing to change"),
  ]);
  const out = await runStep(context({ canvas: { nodes: [{ name: "A", step: "s1", type: "code", params: { code: "// a" }, blanks: [] }], edges: [], version: 1 } }), { callModel, systemPrompt: "P" });
  assert.match(JSON.parse(out.messages[3].content).error, /unknown tool search_nodes/);
  assert.deepEqual(out.result, { kind: "covered" });
  assert.equal(out.events[1].kind, "said");
});

test("交回对不上节点表(类型不在表里、格子不存在),原因退给模型", async () => {
  const wrongType = { kind: "patch", nodes: [{ name: "A", type: "n8n-nodes-base.postgres", params: {}, blanks: [] }], edges: [] };
  const wrongSlot = { kind: "patch", nodes: [{ name: "A", type: "llm", params: { prompt: "p", temperature: 0.2 }, blanks: ["outputSchema"] }], edges: [] };
  /* 链的头上一个 LLM 没有线进来,它要的 Text 哪儿也拿不到——第三样(接得上)也退。 */
  const unfed = { kind: "patch", nodes: [{ name: "A", type: "llm", params: { prompt: "p" }, blanks: ["outputSchema"] }], edges: [] };
  const good = { kind: "patch", nodes: [{ name: "A", type: "readFile", params: { pattern: "*.pdf" }, blanks: ["folder"] }], edges: [] };
  const { callModel } = scripted([assistant([call("submit_step", wrongType)]), assistant([call("submit_step", wrongSlot, "c2")]),
    assistant([call("submit_step", unfed, "c3")]), assistant([call("submit_step", good, "c4")])]);
  const out = await runStep(context(), { callModel, systemPrompt: "P" });
  assert.equal(out.rounds, 4);
  assert.match(JSON.parse(out.messages[3].content).rejected.join(";"), /不在节点表里/);
  assert.match(JSON.parse(out.messages[5].content).rejected.join(";"), /没有 temperature 这一格/);
  assert.match(JSON.parse(out.messages[7].content).rejected.join(";"), /节点 A 要 Text,没有一根线进来/);
  assert.equal(out.result.nodes[0].type, "readFile");
});

/* 说话不交不算交,但也不至于就地作废——来回上限本来就是留给这种情况的。
   原来第一回合说句话就抛错,后面二十九个来回一个都没用上。 */
test("说话不交:把「没收到」说回去,下一回合交了就收下", async () => {
  const good = { kind: "patch", nodes: [{ name: "A", type: "code", params: { code: "// a" }, blanks: [] }], edges: [] };
  const { callModel } = scripted([
    { role: "assistant", content: "先想想这一步要什么。" },
    assistant([call("submit_step", good, "c2")]),
  ]);
  const out = await runStep(context(), { callModel, systemPrompt: "P" });
  assert.equal(out.rounds, 2);
  const nudge = [...out.messages].reverse().find((m) => m.role === "user");
  assert.match(nudge.content, /没有调用任何工具/);
  assert.deepEqual(out.result.nodes, [{ name: "A", step: "s1", type: "code", params: { code: "// a" }, blanks: [] }]);
});

/* 真模型实录:Kimi K3 有时候不走工具,把这一交当正文写出来——`submit_step({...})`。
   接口那头看不到工具调用,这一轮等于什么都没交。得说清楚是「没收到」,
   不然它以为交过了,下一轮接着往下说。 */
test("把 submit_step 写在正文里:当没交,而且说清是没收到", async () => {
  const good = { kind: "patch", nodes: [{ name: "A", type: "code", params: { code: "// a" }, blanks: [] }], edges: [] };
  const { callModel } = scripted([
    { role: "assistant", content: 'submit_step({ "kind": "patch", "nodes": [] })' },
    assistant([call("submit_step", good, "c2")]),
  ]);
  const out = await runStep(context(), { callModel, systemPrompt: "P" });
  assert.equal(out.rounds, 2);
  const told = [...out.messages].reverse().find((m) => m.role === "user");
  assert.match(told.content, /写在正文里.*没有被收到/);
  assert.ok(out.events.some((e) => e.kind === "no-call" && e.wrote === true));
});

test("一直说话不交:来回用完才作废,整段对话挂在错误上", async () => {
  const { callModel } = scripted([
    { role: "assistant", content: "I cannot build this step." },
    { role: "assistant", content: "still thinking." },
  ]);
  await assert.rejects(runStep(context(), { callModel, systemPrompt: "P", maxRounds: 2 }), (error) => {
    assert.match(error.message, /来回 2 次没交/);
    assert.ok(error.messages.length >= 3);
    return true;
  });
});

test("来回到上限没交,这一步作废", async () => {
  const bad = { kind: "patch", nodes: [{ name: "A", type: "没有这种", params: {}, blanks: [] }], edges: [] };
  const replies = Array.from({ length: 3 }, (_, i) => assistant([call("submit_step", bad, `c${i}`)]));
  const { callModel } = scripted(replies);
  await assert.rejects(runStep(context(), { callModel, systemPrompt: "P", maxRounds: 2 }), /来回 2 次没交/);
});

/* 接口抛的错(网络、限流、key 不对)也要带着对话记录:出错那一步的实录最该看,不能是空的 */
test("接口抛错,错误上也挂着对话记录和事件", async () => {
  const callModel = async () => { throw new Error("模型接口返回 429"); };
  await assert.rejects(runStep(context(), { callModel, systemPrompt: "P" }), (error) => {
    assert.match(error.message, /429/);
    assert.equal(error.messages.length, 2);
    assert.deepEqual(error.events, []);
    return true;
  });
});

test("插口:onEvent 拿到事件和上下文;给了目录,每一步自己的实录存进去", async () => {
  const dir = mkdtempSync(join(tmpdir(), "executor-"));
  const submission = { kind: "patch", nodes: [{ name: "A", type: "code", params: { code: "// a" }, blanks: [] }], edges: [] };
  const { callModel } = scripted([assistant([call("submit_step", submission)])]);
  const seen = [];
  const executor = createExecutor({ callModel, systemPrompt: "P", save: dir, onEvent: (event, ctx) => seen.push([ctx.step.ref, event.kind]) });
  const result = await executor(context(), {});
  assert.equal(result.kind, "patch");
  assert.deepEqual(seen, [["s1", "submitted"]]);
  assert.deepEqual(readdirSync(join(dir, "01-s1")).sort(), ["context.json", "events.json", "messages.json", "patch.json", "submission.json"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "01-s1", "messages.json"), "utf8")).length, 3);
});

test("插口:出错也存实录,错照样抛出去", async () => {
  const dir = mkdtempSync(join(tmpdir(), "executor-"));
  const { callModel } = scripted([{ role: "assistant", content: "no" }]);
  const executor = createExecutor({ callModel, systemPrompt: "P", save: dir, maxRounds: 1 });
  await assert.rejects(executor(context(), {}), /来回 1 次没交/);
  assert.deepEqual(readdirSync(join(dir, "01-s1")).sort(), ["context.json", "error.txt", "events.json", "messages.json"]);
});

test("默认导出就是插口:是个函数,import 时不读模型配置", async () => {
  const mod = await import("../../src/executor/executor.mjs");
  assert.equal(typeof mod.default, "function");
});
