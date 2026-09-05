import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowSession } from "../../dist/src/state-machine/workflow-session.mjs";

const plan = {
  readiness: "ready", goal: "读取合同，抽金额并写库", understanding: [], openQuestions: [],
  steps: [1, 2, 3, 4, 5].map((n) => ({ ref: `s${n}`, title: `步骤${n}`, intent: `完成步骤${n}`,
    input: "前一步的数据", output: "本步数据", dependsOn: n === 1 ? [] : [`s${n - 1}`] })),
};
const node = (name, step, type, params = {}, blanks = []) => ({ name, step, type, params, blanks, note: "" });
const nodes = [
  node("读", "s1", "readFile", {}, ["folder"]),
  node("解", "s2", "parseDocument"),
  node("抽", "s3", "llm", { prompt: "抽金额" }, ["outputSchema"]),
  node("算", "s4", "code", { code: "return items;", outputKind: "JSON" }),
  node("写", "s5", "writeDatabase", {}, ["connection", "table"]),
];
const proposal = (value = plan) => ({ role: "assistant", content: "", tool_calls: [{ id: "p1", type: "function",
  function: { name: "propose_plan", arguments: JSON.stringify(value) } }] });
const patch = (context) => ({
  kind: "patch", summary: "抽取和入库均增加币种", review: context.plan.steps.map((step) => ({ step: step.ref, summary: `${step.ref} 已检查影响` })),
  upsertNodes: [
    { ...context.canvas.nodes.find((n) => n.step === "s3"), params: { prompt: "抽金额和币种" } },
    { ...context.canvas.nodes.find((n) => n.step === "s5"), note: "写入金额和币种" },
  ], removeNodes: [], addEdges: [], removeEdges: [],
});
const reply = (context, kind) => ({ kind, summary: kind === "unchanged" ? "现有工作流已经满足要求" : "需要修改全局方案", review: context.plan.steps.map((step) => ({ step: step.ref, summary: "影响已说明" })) });
const request = (session, text = "金额带币种") => ({ node: "抽", step: "s3", canvasVersion: session.canvas.version, text });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function setup(reviser, { callModel = async () => proposal(), beforeBuild = false } = {}) {
  const seen = [];
  const executor = async (context) => {
    seen.push(structuredClone(context));
    const at = plan.steps.findIndex((step) => step.ref === context.step.ref);
    if (context.canvas.nodes.some((n) => n.step === context.step.ref)) return { kind: "covered" };
    return { kind: "patch", nodes: [structuredClone(nodes[at])], edges: at ? [{ from: nodes[at - 1].name, to: nodes[at].name }] : [] };
  };
  const session = createWorkflowSession({ callModel, executor, reviser });
  await session.say("搭建合同流程");
  if (!beforeBuild) await session.start();
  return { session, seen };
}

test("修订只调用一次完整工作流 reviser，s3/s5 原子提交且 Plan 不变", async () => {
  const calls = [];
  const { session, seen } = await setup(async (context) => { calls.push(context); return patch(context); });
  const beforePlan = session.currentPlan, beforeVersions = session.versions, beforeChat = session.transcript;
  const before = session.canvas, events = [];
  assert.equal(session.canvasPlanRevision, 1);
  const pending = session.revise(request(session), { onEdit: (edit) => events.push({ edit, turn: session.turn, canvas: session.canvas }) });
  assert.equal(session.turn, "revision", "同步抢占执行权");
  const edit = await pending;
  assert.equal(calls.length, 1);
  assert.equal(seen.length, 5, "修订没有再次调用任何逐步执行者");
  assert.deepEqual(calls[0].canvas, before);
  assert.deepEqual(calls[0].target, { node: "抽", step: "s3" });
  assert.deepEqual(calls[0].plan, plan);
  assert.equal(calls[0].instruction.text, "金额带币种");
  assert.deepEqual(events.map((event) => event.edit.status), ["processing", "checking", "applied"]);
  assert.deepEqual(events.map((event) => event.canvas.version), [5, 5, 6]);
  assert.equal(events.at(-1).turn, "user", "最终事件先释放执行权");
  assert.equal(edit.status, "applied");
  assert.deepEqual(edit.changes, ["抽", "写"]);
  assert.equal(edit.review.length, 5);
  assert.equal(edit.baseVersion, 5);
  assert.equal(edit.canvasVersion, 6);
  assert.ok(edit.completedAt);
  assert.ok(edit.durationMs >= 0);
  assert.equal(session.canvas.nodes[2].params.prompt, "抽金额和币种");
  assert.equal(session.canvas.nodes[4].note, "写入金额和币种");
  assert.deepEqual(session.currentPlan, beforePlan);
  assert.deepEqual(session.versions, beforeVersions);
  assert.deepEqual(session.transcript, beforeChat);
  assert.equal(session.runs.length, 1, "局部入口产生 edit 记录，不伪装成全图 start 记录");
});

test("候选 s5 校验失败时连有效的 s3 修改也不应用", async () => {
  const { session } = await setup(async (context) => {
    const result = patch(context);
    result.upsertNodes[1].blanks = [];
    return result;
  });
  const before = session.canvas;
  const edit = await session.revise(request(session));
  assert.equal(edit.status, "failed");
  assert.match(edit.reasons.join(), /写.*connection/);
  assert.deepEqual(session.canvas, before);
  assert.equal(session.turn, "user");
});

test("检查时停止同样不提交，事件副本不能篡改修订账本", async () => {
  const { session } = await setup(async (context) => patch(context));
  const before = session.canvas;
  const edit = await session.revise(request(session), { onEdit: (event) => {
    if (event.status === "checking") session.stop();
    event.text = "篡改副本";
  } });
  assert.equal(edit.status, "stopped");
  assert.deepEqual(session.canvas, before);
  assert.equal(session.edits[0].text, "金额带币种");
});

test("revision 与 plan/start/note/第二条修订互斥，stop 后迟到结果不写图", async () => {
  const gate = deferred();
  let context;
  const { session } = await setup(async (value) => { context = value; return gate.promise; });
  const before = session.canvas;
  const pending = session.revise(request(session));
  assert.throws(() => session.revise(request(session)), /工作流修订在跑/);
  await assert.rejects(session.say("修改方案"), /工作流修订在跑/);
  await assert.rejects(session.start(), /工作流修订在跑/);
  assert.throws(() => session.annotate("s3", "另一个要求"), /工作流修订在跑/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.stop(), "revision");
  const edit = await pending;
  assert.equal(edit.status, "stopped");
  assert.equal(session.turn, "user");
  gate.resolve(patch(context));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(session.canvas, before);
  assert.equal(session.edits[0].status, "stopped");
});

test("新指令收到全部已确认要求、全部旧批注和有限历史；重新构建也保留要求", async () => {
  const calls = [];
  const { session, seen } = await setup(async (context) => {
    calls.push(structuredClone(context));
    return calls.length === 1 ? patch(context) : reply(context, "unchanged");
  });
  session.annotate("s1", "只读昨日文件");
  await session.revise(request(session));
  for (let i = 0; i < 4; i += 1) await session.start();
  await session.revise(request(session, "确认币种已写库"));
  assert.deepEqual(calls[1].requirements, [{ target: { node: "抽", step: "s3" }, text: "金额带币种" }]);
  assert.deepEqual(calls[1].annotations, [{ step: "s1", text: "只读昨日文件" }]);
  assert.equal(calls[1].history.runs.length, 3);
  assert.equal(calls[1].history.edits[0].status, "applied");
  assert.equal(calls[1].history.edits[0].text, "金额带币种");
  assert.equal(calls[1].history.edits[0].messages, undefined);
  assert.equal(calls[1].transcript, undefined);
  assert.deepEqual(seen.at(-1).requirements, calls[1].requirements);
  await session.revise(request(session, "再确认"));
  assert.equal(calls[2].requirements.length, 2, "unchanged 也保留用户已经确认的要求");
});

test("unchanged/needs_plan 不改画布和 Plan，needs_plan 不进入已应用要求", async () => {
  const calls = [];
  const { session } = await setup(async (context) => { calls.push(context); return reply(context, calls.length === 1 ? "needs_plan" : "unchanged"); });
  const before = session.canvas;
  const first = await session.revise(request(session, "删除发起节点"));
  assert.equal(first.status, "needs_plan");
  assert.deepEqual(session.canvas, before);
  await session.revise(request(session));
  assert.deepEqual(calls[1].requirements, []);
  assert.equal(session.revision, 1);
  assert.deepEqual(session.canvas, before);
});

test("失效请求同步拒绝，不创建记录不调用修订者", async () => {
  let calls = 0;
  const { session } = await setup(async (context) => { calls += 1; return patch(context); });
  for (const [override, why] of [
    [{ node: "不存在" }, /目标节点/],
    [{ step: "s5" }, /目标节点/],
    [{ canvasVersion: 4 }, /画布已更新/],
    [{ canvasVersion: "5" }, /画布已更新/],
    [{ text: "  " }, /指令是空的/],
  ]) assert.throws(() => session.revise({ ...request(session), ...override }), why);
  assert.equal(session.edits.length, 0);
  assert.equal(session.turn, "user");
  assert.equal(calls, 0);
});

test("新方案尚未应用时即便节点 ref 全部相同也不允许修订", async () => {
  let count = 0;
  const { session } = await setup(async (context) => patch(context), {
    callModel: async () => proposal(++count === 1 ? plan : { ...plan, goal: "新的目标" }),
  });
  await session.say("修改全局目标");
  assert.equal(session.revision, 2);
  assert.equal(session.canvasPlanRevision, 1);
  assert.throws(() => session.revise(request(session)), /当前方案尚未完成构建/);
  await session.start();
  assert.equal(session.canvasPlanRevision, 2);
  assert.equal((await session.revise(request(session))).status, "applied");
});

test("尚未构建、缺修订者、模型异常和 getter 副本均守住会话", async () => {
  const pending = await setup(async (context) => patch(context), { beforeBuild: true });
  assert.equal(pending.session.canvasPlanRevision, null);
  assert.throws(() => pending.session.revise(request(pending.session)), /尚未完成构建/);
  const absent = await setup(undefined);
  assert.equal(absent.session.hasReviser, false);
  assert.throws(() => absent.session.revise(request(absent.session)), /未接入/);
  const { session } = await setup(async () => { throw Object.assign(new Error("模型不可用"), { events: [{ kind: "rejected", reasons: ["写库字段不合法"] }] }); });
  const edit = await session.revise(request(session));
  assert.equal(edit.status, "failed");
  assert.equal(edit.error, "模型不可用");
  assert.deepEqual(edit.reasons, ["写库字段不合法"]);
  const exposed = session.edits;
  exposed[0].status = "applied";
  assert.equal(session.edits[0].status, "failed");
  assert.equal(session.turn, "user");
});

test("模型改了自己的上下文也不能改变门禁基线或方案", async () => {
  const { session } = await setup(async (context) => {
    const result = patch(context);
    context.canvas.nodes[0].params.folder = "恶意写入副本";
    context.plan.steps.pop();
    return result;
  });
  assert.equal((await session.revise(request(session))).status, "applied");
  assert.equal(session.currentPlan.steps.length, 5);
  assert.equal(session.canvas.nodes[0].params.folder, undefined);
});

test("Plan Agent 已占用执行权时不能进入修订", async () => {
  const gate = deferred();
  let calls = 0;
  const { session } = await setup(async (context) => patch(context), {
    callModel: async () => ++calls === 1 ? proposal() : gate.promise,
  });
  const talking = session.say("补充方案说明");
  assert.equal(session.turn, "plan");
  assert.throws(() => session.revise(request(session)), /Plan Agent 在跑/);
  gate.resolve(proposal());
  await talking;
});

test("构建结束但整图检查失败时，公开具体原因并禁止修订", async () => {
  const session = createWorkflowSession({
    callModel: async () => proposal({ ...plan, steps: plan.steps.slice(0, 2) }),
    executor: async (context) => ({
      kind: "patch", nodes: [node(context.step.ref, context.step.ref, "code", { code: "return items;" })],
      edges: context.step.ref === "s1" ? [] : [{ from: "s1", to: "s2" }, { from: "s2", to: "s1" }],
    }),
    reviser: async (context) => reply(context, "unchanged"),
  });
  await session.say("建两步");
  const run = await session.start();
  assert.equal(run.endedBy, "finished");
  assert.deepEqual(run.problems, ["画布的连线存在环"]);
  assert.equal(session.canvasPlanRevision, null);
  assert.throws(() => session.revise({ node: "s2", step: "s2", canvasVersion: 2, text: "改一下" }), /尚未完成构建/);
});
