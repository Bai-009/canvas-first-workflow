import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWorkflowSession, checkResult, wholeCanvasProblems } from "../../src/state-machine/workflow-session.mjs";
import { stepWaves } from "../../src/state-machine/step-context.mjs";
import fixedExecutor from "../../fixtures/doubles/fixed-executor.mjs";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const run8 = read("../../fixtures/observed/run8-原因版提示词/turn-2.plan.json");

/* 假模型:每次都把 run8 那份方案提交上来,好让会话手里有方案。 */
let callCounter = 0;
const submitting = (plan) => async () => ({
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id: `call_${++callCounter}`,
      type: "function",
      function: { name: "propose_plan", arguments: JSON.stringify(plan) },
    },
  ],
});

/* 执行者的固定答复:按这一步的编号查表。 */
const node = (step, name, extra = {}) => ({ name, step, type: "code", params: { code: `// ${step}` }, blanks: [], ...extra });
const patch = (nodes, edges = []) => ({ kind: "patch", nodes, edges });
const covered = { kind: "covered" };
const chain = {
  s1: () => patch([node("s1", "n1")]),
  s2: () => patch([node("s2", "n2")], [{ from: "n1", to: "n2" }]),
  s3: () => patch([node("s3", "n3", { type: "llm", params: { prompt: "抽字段" }, blanks: ["outputSchema"] })], [{ from: "n2", to: "n3" }]),
  s4: () => patch([node("s4", "n4", { type: "writeDatabase", params: {}, blanks: ["connection", "table"] })], [{ from: "n3", to: "n4" }]),
};
function byStep(handlers) {
  const contexts = [];
  const executor = async (context, { signal }) => {
    contexts.push(structuredClone(context));
    return handlers[context.step.ref](context, signal);
  };
  return { executor, contexts };
}

async function sessionWithPlan(executor) {
  const session = createWorkflowSession({ callModel: submitting(run8), executor });
  await session.say("每天定时把新增的合同 PDF 解析出关键字段,写进数据库");
  return session;
}

/* 一个 If 的两条分支落到同一个节点上,是两条不同的线。出口丢了或者被当成重复线并掉,
   画布上就只剩一条,分支消失——用户看到的工作流跟真正的工作流不是一回事。 */
test("分支的出口留在画布上:同一对节点之间,true 和 false 是两条线", async () => {
  const branching = {
    s1: () => patch([node("s1", "岔路", { type: "condition", params: { condition: "input.ok" } })]),
    s2: () => patch([node("s2", "收口")], [
      { from: "岔路", to: "收口", output: "true" },
      { from: "岔路", to: "收口", output: "false" },
    ]),
    s3: () => covered,
    s4: () => covered,
  };
  const session = await sessionWithPlan(byStep(branching).executor);
  await session.start();
  assert.deepEqual(session.canvas.edges, [
    { from: "岔路", to: "收口", output: "true" },
    { from: "岔路", to: "收口", output: "false" },
  ]);
});

/* 计划从来就是个图不是条线:接在同一个前序后面、彼此不依赖的步,该同时走。 */
test("走步排成波次:互不依赖的步凑一波", () => {
  assert.deepEqual(
    stepWaves({ steps: [
      { ref: "s1", dependsOn: [] },
      { ref: "s2", dependsOn: ["s1"] },
      { ref: "s3", dependsOn: ["s1"] },
      { ref: "s4", dependsOn: ["s2", "s3"] },
    ] }),
    [["s1"], ["s2", "s3"], ["s4"]]
  );
  assert.throws(() => stepWaves({ steps: [
    { ref: "a", dependsOn: ["b"] }, { ref: "b", dependsOn: ["a"] },
  ] }), /互相等着/);
});

/* 同一波里的两步拿到同一版画布,说明它们真的一起走了,不是排队。
   看不见对方是对的 —— 它们本来就互不依赖。 */
test("同一波的步同时走:两边拿到的是同一版画布", async () => {
  const forked = structuredClone(run8);
  forked.steps[0].dependsOn = [];
  forked.steps[1].dependsOn = ["s1"];
  forked.steps[2].dependsOn = ["s1"];
  forked.steps[3].dependsOn = ["s2", "s3"];
  const seen = {};
  const handlers = {
    s1: () => patch([node("s1", "n1")]),
    s2: (context) => { seen.s2 = context.canvas.version; return patch([node("s2", "n2")], [{ from: "n1", to: "n2" }]); },
    s3: (context) => { seen.s3 = context.canvas.version; return patch([node("s3", "n3")], [{ from: "n1", to: "n3" }]); },
    s4: () => patch([node("s4", "n4")], [{ from: "n2", to: "n4" }, { from: "n3", to: "n4" }]),
  };
  const session = createWorkflowSession({ callModel: submitting(forked), executor: byStep(handlers).executor });
  await session.say("每天定时把新增的合同 PDF 解析出关键字段,写进数据库");
  const run = await session.start();
  assert.equal(run.endedBy, "finished");
  assert.deepEqual(run.steps.map((s) => s.ref), ["s1", "s2", "s3", "s4"]);
  assert.equal(seen.s2, seen.s3);
  assert.deepEqual(run.problems, []);
});

test("没有方案不能开始;执行者位置空着也不能开始", async () => {
  const empty = createWorkflowSession({ callModel: submitting(run8), executor: byStep(chain).executor });
  await assert.rejects(empty.start(), /还没有方案/);
  const noExecutor = await sessionWithPlan(null);
  assert.equal(noExecutor.hasExecutor, false);
  await assert.rejects(noExecutor.start(), /执行者的位置空着/);
});

test("按开始:四步按顺序做完,画布版本每提交加一,记录写的都是真发生的", async () => {
  const { executor, contexts } = byStep(chain);
  const session = await sessionWithPlan(executor);
  assert.equal(session.turn, "user");
  const run = await session.start();
  assert.equal(session.turn, "user");
  assert.deepEqual(run.steps.map((s) => [s.ref, s.outcome, s.canvasVersion]), [
    ["s1", "done", 1], ["s2", "done", 2], ["s3", "done", 3], ["s4", "done", 4],
  ]);
  assert.equal(run.endedBy, "finished");
  assert.deepEqual(run.problems, []);
  assert.equal(run.revision, 1);
  assert.deepEqual(session.canvas.nodes.map((n) => n.name), ["n1", "n2", "n3", "n4"]);
  assert.deepEqual(session.canvas.edges, [
    { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" },
  ]);
  assert.equal(session.canvas.version, 4);
  assert.deepEqual(contexts.map((c) => c.step.ref), ["s1", "s2", "s3", "s4"]);
});

test("每一步的上下文:整份方案、这一步、做到这步时的画布、这步的问题、这步的批注", async () => {
  const { executor, contexts } = byStep(chain);
  const session = await sessionWithPlan(executor);
  session.annotate("s3", "金额字段要带币种");
  await session.start();
  const [c1, , c3] = contexts;
  assert.deepEqual(Object.keys(c1), ["plan", "step", "canvas", "openQuestions", "instructions"]);
  assert.deepEqual(c1.plan, run8);
  assert.deepEqual(c1.canvas, { nodes: [], edges: [], version: 0 });
  assert.deepEqual(c1.openQuestions, []);
  assert.deepEqual(c1.instructions, []);
  assert.deepEqual(c3.canvas.nodes.map((n) => n.name), ["n1", "n2"]);   // s3 开工时画布上有 s1 s2 的节点
  assert.equal(c3.canvas.version, 2);
  assert.deepEqual(c3.openQuestions.map((q) => q.ref), ["q3"]);
  assert.deepEqual(c3.instructions, ["金额字段要带币种"]);
});

test("已经有了:画布不动、版本不加,记录里写 covered", async () => {
  const { executor } = byStep({ ...chain, s3: () => covered, s4: () => covered });
  const session = await sessionWithPlan(executor);
  const run = await session.start();
  assert.deepEqual(run.steps.map((s) => [s.ref, s.outcome, s.canvasVersion]), [
    ["s1", "done", 1], ["s2", "done", 2], ["s3", "covered", 2], ["s4", "covered", 2],
  ]);
  assert.equal(session.canvas.version, 2);
  /* 整张画布查一遍:s3 s4 说有了,画布上却没有,记成问题,不藏 */
  assert.deepEqual(run.problems, ["s3 在画布上没有节点", "s4 在画布上没有节点"]);
});

test("跑着的时候不收话、不收批注、不收第二次开始", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { executor } = byStep({ ...chain, s2: async () => { await gate; return chain.s2(); } });
  const session = await sessionWithPlan(executor);
  const running = session.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(session.turn, "executor");
  await assert.rejects(session.say("再加一步"), /执行者在跑/);
  assert.throws(() => session.annotate("s1", "x"), /执行者在跑/);
  await assert.rejects(session.start(), /执行者在跑/);
  release();
  const run = await running;
  assert.equal(run.endedBy, "finished");
  assert.equal(session.turn, "user");
});

test("按停:正在做的这一步作废,画布停在上次提交;再开始从 s1 起,做过的说已经有了", async () => {
  let startedS2;
  const s2Started = new Promise((resolve) => { startedS2 = resolve; });
  const hangUntilAborted = (signal) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("停了", "AbortError"))));
  const first = byStep({ ...chain, s2: (_, signal) => { startedS2(); return hangUntilAborted(signal); } });
  const session = await sessionWithPlan(first.executor);
  const running = session.start();
  await s2Started;
  assert.equal(session.stop(), "executor");
  const run = await running;
  assert.deepEqual(run.steps.map((s) => [s.ref, s.outcome, s.canvasVersion]), [["s1", "done", 1], ["s2", "stopped", 1]]);
  assert.equal(run.endedBy, "stopped");
  assert.equal(session.canvas.version, 1);
  assert.deepEqual(session.canvas.nodes.map((n) => n.name), ["n1"]);
  assert.equal(session.turn, "user");
  assert.equal(session.stop(), false);
});

test("执行者不理会停止信号、停了还交东西,一样不收", async () => {
  let startedS2;
  const s2Started = new Promise((resolve) => { startedS2 = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { executor } = byStep({ ...chain, s2: async () => { startedS2(); await gate; return chain.s2(); } });
  const session = await sessionWithPlan(executor);
  const running = session.start();
  await s2Started;
  session.stop();
  release();
  const run = await running;
  assert.deepEqual(run.steps.at(-1), { ref: "s2", outcome: "stopped", canvasVersion: 1 });
  assert.equal(session.canvas.version, 1);
});

test("批注挂在步骤上;再开始从 s1 重走,s1 拿到批注,s2 看到新的 s1", async () => {
  const seenByS1 = [];
  const seenByS2 = [];
  let s1Version = 0;
  const { executor } = byStep({
    ...chain,
    s1: (context) => { seenByS1.push(context.instructions); s1Version += 1; return patch([node("s1", `n1-v${s1Version}`)]); },
    s2: (context) => {
      seenByS2.push(context.canvas.nodes.filter((n) => n.step === "s1").map((n) => n.name));
      const upstream = context.canvas.nodes.find((n) => n.step === "s1").name;
      return patch([node("s2", "n2")], [{ from: upstream, to: "n2" }]);
    },
    s3: (context) => (context.canvas.nodes.some((n) => n.name === "n3") ? covered : chain.s3()),
    s4: (context) => (context.canvas.nodes.some((n) => n.name === "n4") ? covered : chain.s4()),
  });
  const session = await sessionWithPlan(executor);
  const run1 = await session.start();
  assert.equal(run1.endedBy, "finished");
  session.annotate("s1", "PDF 太大,先拆成单页图片再往下送");
  assert.deepEqual(session.annotations, [{ step: "s1", text: "PDF 太大,先拆成单页图片再往下送" }]);
  const run2 = await session.start();
  assert.deepEqual(seenByS1, [[], ["PDF 太大,先拆成单页图片再往下送"]]);
  assert.deepEqual(seenByS2, [["n1-v1"], ["n1-v2"]]);
  assert.deepEqual(run2.steps.map((s) => [s.ref, s.outcome]), [["s1", "done"], ["s2", "done"], ["s3", "covered"], ["s4", "covered"]]);
  /* 老的 s1 节点连同它的线一起换掉;新 s1 接到 s2 */
  assert.deepEqual(session.canvas.nodes.filter((n) => n.step === "s1").map((n) => n.name), ["n1-v2"]);
  assert.deepEqual(session.canvas.edges, [{ from: "n2", to: "n3" }, { from: "n3", to: "n4" }, { from: "n1-v2", to: "n2" }]);
  assert.deepEqual(run2.problems, []);
  assert.equal(session.runs.length, 2);
});

test("上游重做了、下游却说已经有了:线断了,整张画布查出来写进记录", async () => {
  let s1Version = 0;
  const { executor } = byStep({
    ...chain,
    s1: () => { s1Version += 1; return patch([node("s1", `n1-v${s1Version}`)]); },
    s2: (context) => (context.canvas.nodes.some((n) => n.name === "n2") ? covered : patch([node("s2", "n2")], [{ from: "n1-v1", to: "n2" }])),
    s3: (context) => (context.canvas.nodes.some((n) => n.name === "n3") ? covered : chain.s3()),
    s4: (context) => (context.canvas.nodes.some((n) => n.name === "n4") ? covered : chain.s4()),
  });
  const session = await sessionWithPlan(executor);
  await session.start();
  const run2 = await session.start();
  assert.equal(run2.endedBy, "finished");
  assert.deepEqual(run2.problems, ["s2 接在 s1 后面,画布上却没有一条线从 s1 接到 s2"]);
});

test("执行者只能改自己这一步的节点;查不过就停在这一步,画布不动", async () => {
  const { executor } = byStep({ ...chain, s2: () => patch([node("s1", "n9")]) });
  const session = await sessionWithPlan(executor);
  const run = await session.start();
  assert.equal(run.endedBy, "rejected");
  assert.deepEqual(run.steps.at(-1).ref, "s2");
  assert.match(run.steps.at(-1).reasons[0], /标的是 "s1",这一轮做的是 s2/);
  assert.equal(session.canvas.version, 1);
  assert.equal(session.turn, "user");
});

test("一步交回好几个节点却不连在一起:停在这一步,画布不动", async () => {
  const { executor } = byStep({
    ...chain,
    s1: () => patch([node("s1", "读取 PDF"), node("s1", "提取文字层"), node("s1", "有文字层？")]),
  });
  const session = await sessionWithPlan(executor);
  const run = await session.start();
  assert.equal(run.endedBy, "rejected");
  assert.equal(run.steps.at(-1).ref, "s1");
  assert.match(run.steps.at(-1).reasons[0], /提取文字层、有文字层？ 没跟其它几个连在一起/);
  assert.deepEqual(session.canvas.nodes, []);
});

test("几个节点都挂在同一个上游节点上也算连在一起:分支放行", async () => {
  const { executor } = byStep({
    ...chain,
    s2: () => patch(
      [node("s2", "走电子版"), node("s2", "走扫描件")],
      [{ from: "n1", to: "走电子版" }, { from: "n1", to: "走扫描件" }],
    ),
    s3: (context) => patch([node("s3", "n3", { type: "llm", params: { prompt: "抽字段" }, blanks: ["outputSchema"] })],
      [{ from: "走电子版", to: "n3" }, { from: "走扫描件", to: "n3" }]),
  });
  const session = await sessionWithPlan(executor);
  const run = await session.start();
  assert.equal(run.endedBy, "finished");
  assert.deepEqual(session.canvas.nodes.filter((n) => n.step === "s2").map((n) => n.name), ["走电子版", "走扫描件"]);
});

test("接在上一步后面却不接线:停在这一步,画布不动", async () => {
  /* s3 只交回一个节点,连不连得上不看它自己那几个节点,看它有没有接到 s2 上。 */
  const { executor } = byStep({
    ...chain,
    s3: () => patch([node("s3", "n3", { type: "llm", params: { prompt: "抽字段" }, blanks: ["outputSchema"] })]),
  });
  const session = await sessionWithPlan(executor);
  const run = await session.start();
  assert.equal(run.endedBy, "rejected");
  assert.equal(run.steps.at(-1).ref, "s3");
  assert.match(run.steps.at(-1).reasons[0], /s3 接在 s2 后面,却没有一条线从那几步的节点接进来/);
  assert.equal(session.canvas.nodes.length, 2);
});

test("链路的头不查上游:重走 s1 交回一个孤零零的节点是对的", async () => {
  let version = 0;
  const { executor } = byStep({
    ...chain,
    s1: () => { version += 1; return patch([node("s1", `n1-v${version}`)]); },
    s2: (context) => patch([node("s2", "n2")],
      [{ from: context.canvas.nodes.find((n) => n.step === "s1").name, to: "n2" }]),
    s3: (context) => (context.canvas.nodes.some((n) => n.name === "n3") ? covered : chain.s3()),
    s4: (context) => (context.canvas.nodes.some((n) => n.name === "n4") ? covered : chain.s4()),
  });
  const session = await sessionWithPlan(executor);
  assert.equal((await session.start()).endedBy, "finished");
  assert.equal((await session.start()).endedBy, "finished");
});

test("执行者出错:记下来,停在这一步,换回用户", async () => {
  const { executor } = byStep({ ...chain, s3: () => { throw new Error("平台连不上"); } });
  const session = await sessionWithPlan(executor);
  const run = await session.start();
  assert.equal(run.endedBy, "error");
  assert.deepEqual(run.steps.at(-1), { ref: "s3", outcome: "failed", canvasVersion: 2, error: "平台连不上" });
  assert.equal(session.turn, "user");
});

test("方案换了版本,再开始走的是新方案的步", async () => {
  const shorter = { ...run8, readiness: "ready", steps: run8.steps.slice(0, 2), openQuestions: [] };
  const plans = [run8, shorter];
  const callModel = async () => submitting(plans.shift())();
  const { executor, contexts } = byStep({ ...chain, s2: (context) => patch([node("s2", "n2")], [{ from: "n1", to: "n2" }]) });
  const session = createWorkflowSession({ callModel, executor });
  await session.say("第一句");
  await session.start();
  await session.say("只要前两步");
  assert.equal(session.revision, 2);
  const run = await session.start();
  assert.equal(run.revision, 2);
  assert.deepEqual(run.steps.map((s) => s.ref), ["s1", "s2"]);
  assert.deepEqual(contexts.at(-1).plan.steps.map((s) => s.ref), ["s1", "s2"]);
});

test("Plan Agent 在跑的时候不能开始、不能批注;停掉的是 Plan Agent", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const callModel = async (_, { signal } = {}) => {
    await new Promise((resolve, reject) => {
      gate.then(resolve);
      signal?.addEventListener("abort", () => reject(new DOMException("停了", "AbortError")));
    });
    return submitting(run8)();
  };
  const session = createWorkflowSession({ callModel, executor: byStep(chain).executor });
  const talking = session.say("你好");
  await new Promise((r) => setImmediate(r));
  assert.equal(session.turn, "plan");
  await assert.rejects(session.start(), /Plan Agent 在跑/);
  assert.throws(() => session.annotate("s1", "x"), /Plan Agent 在跑/);
  assert.equal(session.stop(), "plan");
  await assert.rejects(talking, { name: "AbortError" });
  release();
  assert.equal(session.turn, "user");
});

test("画布闸门里机器能查的几条", () => {
  const canvas = { nodes: [node("s1", "n1")], edges: [], version: 1 };
  assert.deepEqual(checkResult(covered, "s2", canvas), []);
  assert.deepEqual(checkResult(null, "s2", canvas), ["交回的不是一个对象"]);
  assert.match(checkResult({ kind: "done" }, "s2", canvas)[0], /只认 patch 和 covered/);
  assert.match(checkResult(patch([]), "s2", canvas)[0], /没有节点/);
  assert.match(checkResult(patch([node("s2", "n1")]), "s2", canvas)[0], /n1 已被 s1 用了/);
  assert.match(checkResult(patch([node("s2", "n2"), node("s2", "n2")]), "s2", canvas)[0], /n2 重复/);
  assert.match(checkResult(patch([node("s2", "n2")], [{ from: "n7", to: "n2" }]), "s2", canvas)[0], /接了不存在的节点/);
  assert.match(checkResult(patch([node("s2", "n2")], [{ from: "n2", to: "n2" }]), "s2", canvas)[0], /接到了自己/);
  assert.match(checkResult(patch([node("s2", "n2")], [{ from: "n1", to: "n1" }]), "s2", canvas).join(), /两头都不是 s2 的节点|接到了自己/);
  assert.match(checkResult(patch([{ ...node("s2", "n2"), blanks: [1] }]), "s2", canvas)[0], /blanks 不是字符串数组/);
  /* 同一步自己原来的编号可以再用:原地改 */
  assert.deepEqual(checkResult(patch([node("s1", "n1")]), "s1", canvas), []);
});

test("整张画布查一遍:每一步有节点,接在谁后面就有线从那一步接过来", () => {
  const canvas = {
    nodes: [node("s1", "n1"), node("s2", "n2"), node("s3", "n3"), node("s4", "n4")],
    edges: [{ from: "n1", to: "n2" }, { from: "n3", to: "n4" }],
    version: 4,
  };
  assert.deepEqual(wholeCanvasProblems(run8, canvas), ["s3 接在 s2 后面,画布上却没有一条线从 s2 接到 s3"]);
});

/* 固定答复是命令行里唯一能插进状态机的东西。它交的形状不跟着契约走,/start 就在闸门上死,测试却照样全绿——
   09-03 改名(id → name)时就这么漏过一回。所以让它真的插进来走一遍。 */
test("固定答复插进状态机能走完整条链,再开始一次全是已经有了", async () => {
  const session = await sessionWithPlan(fixedExecutor);
  const first = await session.start();
  assert.equal(first.endedBy, "finished");
  assert.deepEqual(first.steps.map((s) => s.outcome), ["done", "done", "done", "done"]);
  assert.deepEqual(first.problems, []);
  const canvas = session.canvas;
  assert.deepEqual(canvas.nodes.map((n) => n.name).sort(), ["s1-固定答复", "s2-固定答复", "s3-固定答复", "s4-固定答复"]);
  assert.ok(canvas.edges.length > 0);
  assert.ok(canvas.edges.every((e) => typeof e.from === "string" && typeof e.to === "string"));
  const second = await session.start();
  assert.deepEqual(second.steps.map((s) => s.outcome), ["covered", "covered", "covered", "covered"]);
});
