import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepMessage, toPatch, runStep, createExecutor } from "../../src/executor/executor.mjs";

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

test("一步的来回:搜、查、交;答案接在对话后面,交的过闸门就还回去", async () => {
  const submission = {
    kind: "patch",
    nodes: [
      { name: "Every day", type: "n8n-nodes-base.scheduleTrigger", params: { rule: { interval: [{ field: "days" }] } }, blanks: [] },
      { name: "Read PDFs", type: "n8n-nodes-base.readWriteFile", params: { fileSelector: "" }, blanks: ["fileSelector"] },
    ],
    edges: [{ from: "Every day", to: "Read PDFs" }],
  };
  const { callModel, seen } = scripted([
    assistant([call("search_nodes", { query: "read files from disk" })]),
    assistant([call("describe_node", { type: "n8n-nodes-base.readWriteFile", operation: "read" }, "c2")]),
    assistant([call("submit_step", submission, "c3")]),
  ]);
  const events = [];
  const out = await runStep(context(), { callModel, systemPrompt: "P", onEvent: (e) => events.push(e.kind) });
  assert.equal(out.rounds, 3);
  assert.deepEqual(seen[2], ["system", "user", "assistant", "tool", "assistant", "tool"]);
  const searchReply = JSON.parse(out.messages[3].content);
  assert.ok(searchReply.some((n) => n.type === "n8n-nodes-base.readWriteFile"));
  const describeReply = JSON.parse(out.messages[5].content);
  assert.ok(describeReply.properties.some((p) => p.name === "fileSelector"));
  assert.deepEqual(events, ["tool", "tool", "submitted"]);
  assert.equal(out.result.kind, "patch");
  assert.deepEqual(out.result.nodes.map((n) => [n.name, n.step]), [["Every day", "s1"], ["Read PDFs", "s1"]]);
  assert.deepEqual(out.submission, submission);
});

test("闸门不认的交回,原因退给模型,它再交", async () => {
  const bad = { kind: "patch", nodes: [{ name: "A", type: "t", params: "not an object", blanks: [] }], edges: [] };
  const good = { kind: "patch", nodes: [{ name: "A", type: "t", params: {}, blanks: [] }], edges: [] };
  const { callModel } = scripted([assistant([call("submit_step", bad)]), assistant([call("submit_step", good, "c2")])]);
  const out = await runStep(context(), { callModel, systemPrompt: "P" });
  assert.equal(out.rounds, 2);
  const rejection = JSON.parse(out.messages[3].content);
  assert.match(rejection.rejected.join(";"), /params/);
  assert.deepEqual(out.result.nodes, [{ name: "A", step: "s1", type: "t", params: {}, blanks: [] }]);
});

test("查详情报错(没有那种操作)当答案退给模型,来回继续", async () => {
  const { callModel } = scripted([
    assistant([call("describe_node", { type: "n8n-nodes-base.postgres", operation: "fly" })]),
    assistant([call("submit_step", { kind: "covered" }, "c2")], "nothing to change"),
  ]);
  const out = await runStep(context({ canvas: { nodes: [{ name: "A", step: "s1", type: "t", params: {}, blanks: [] }], edges: [], version: 1 } }), { callModel, systemPrompt: "P" });
  assert.match(JSON.parse(out.messages[3].content).error, /没有 fly 这种操作/);
  assert.deepEqual(out.result, { kind: "covered" });
  assert.equal(out.events[1].kind, "said");
});

test("说话不交:抛错带着它说的话,整段对话挂在错误上", async () => {
  const { callModel } = scripted([{ role: "assistant", content: "I cannot build this step." }]);
  await assert.rejects(runStep(context(), { callModel, systemPrompt: "P" }), (error) => {
    assert.match(error.message, /说话没交.*I cannot build this step/);
    assert.equal(error.messages.length, 3);
    return true;
  });
});

test("来回到上限没交,这一步作废", async () => {
  const replies = Array.from({ length: 3 }, (_, i) => assistant([call("search_nodes", { query: "again" }, `c${i}`)]));
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
  const submission = { kind: "patch", nodes: [{ name: "A", type: "t", params: {}, blanks: [] }], edges: [] };
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
  const executor = createExecutor({ callModel, systemPrompt: "P", save: dir });
  await assert.rejects(executor(context(), {}), /说话没交/);
  assert.deepEqual(readdirSync(join(dir, "01-s1")).sort(), ["context.json", "error.txt", "events.json", "messages.json"]);
});

test("默认导出就是插口:是个函数,import 时不读模型配置", async () => {
  const mod = await import("../../src/executor/executor.mjs");
  assert.equal(typeof mod.default, "function");
});
