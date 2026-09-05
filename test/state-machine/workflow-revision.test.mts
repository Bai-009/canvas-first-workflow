import type { RevisionContext } from "../../shared/workflow.mjs";
import type { RevisionResult } from "../../shared/contracts.mjs";
import { present, planWithSteps, revisionNode } from "../helpers/fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { inspectRevision } from "../../src/state-machine/workflow-revision.mjs";

const node = (name: string, step: string, type: string, params: Record<string, unknown> = {}, blanks: string[] = []) => ({ name, step, type, params, blanks, note: "" });
const context = (): RevisionContext => ({
  plan: planWithSteps([1, 2, 3, 4, 5].map((n) => ({ ref: `s${n}`, dependsOn: n === 1 ? [] : [`s${n - 1}`] }))),
  canvas: {
    version: 5,
    nodes: [
      node("读", "s1", "readFile", {}, ["folder"]),
      node("解", "s2", "parseDocument"),
      node("抽", "s3", "llm", { prompt: "抽金额", outputSchema: { type: "object", properties: { amount: { type: "number" } } } }),
      node("算", "s4", "code", { code: "return items.map(item => ({ ...item, amount: item.amount }));", outputKind: "JSON" }),
      node("写", "s5", "writeDatabase", {}, ["connection", "table"]),
    ],
    edges: ["读", "解", "抽", "算"].map((from, i) => ({ from, to: present(["解", "抽", "算", "写"][i]) })),
  },
  target: { node: "抽", step: "s3" }, instruction: { id: "edit-1", text: "金额带币种" },
});
const mutations = (cases: [((result: Patch) => void), RegExp][]) => cases;
type Patch = Extract<RevisionResult, { kind: "patch" }>;
const patch = (ctx: RevisionContext): Patch => ({
  kind: "patch", summary: "抽取币种，并明确入库字段",
  review: ctx.plan.steps.map((step) => ({ step: step.ref, summary: "已检查该步骤的影响" })),
  upsertNodes: [
    { ...structuredClone(revisionNode(ctx.canvas.nodes[2])), params: { prompt: "抽金额和币种", outputSchema: { type: "object", properties: { amount: { type: "number" }, currency: { type: "string" } } } } },
    { ...structuredClone(revisionNode(ctx.canvas.nodes[4])), note: "金额与币种按字段名写入" },
  ],
  removeNodes: [], addEdges: [], removeEdges: [],
});

test("从 s3 发起的修订可以同时改变 s3 和 s5，候选独立于原图和模型结果", () => {
  const ctx = context(), before = structuredClone(ctx), result = patch(ctx);
  const inspected = inspectRevision(result, ctx);
  assert.deepEqual(inspected.reasons, []);
  assert.deepEqual(inspected.changes, ["抽", "写"]);
  assert.deepEqual(ctx, before);
  assert.equal(present(inspected.candidate).version, 5, "纯检查不替会话增加版本");
  present(present(inspected.candidate).nodes[2]).params.prompt = "修改候选副本";
  assert.equal(present(result.upsertNodes[0]).params.prompt, "抽金额和币种");
});

test("s5 的参数或输入契约失败时，不返回任何可提交候选", () => {
  const ctx = context(), result = patch(ctx);
  present(result.upsertNodes[1]).blanks = [];
  let checked = inspectRevision(result, ctx);
  assert.match(checked.reasons.join(), /写.*connection.*没填/);
  assert.equal(checked.candidate, undefined);
  result.upsertNodes[1] = node("写", "s5", "writeVectorStore", {}, ["connection", "collection"]);
  checked = inspectRevision(result, ctx);
  assert.match(checked.reasons.join(), /写 要 Vector/);
  assert.equal(checked.candidate, undefined);
});

test("review 是逐步的影响说明，不能遗漏、重复或新增方案步骤", () => {
  const ctx = context(), result = patch(ctx);
  result.review = result.review.slice(0, 4);
  assert.match(inspectRevision(result, ctx).reasons.join(), /缺少 s5/);
  result.review.push(present(result.review[0]), { step: "s9", summary: "多出一步" });
  assert.match(inspectRevision(result, ctx).reasons.join(), /重复说明了 s1/);
  assert.match(inspectRevision(result, ctx).reasons.join(), /没有的步骤 s9/);
});

test("工具 schema 的完整节点要求同样由门禁执行", () => {
  const ctx = context(), result = patch(ctx);
  Reflect.deleteProperty(present(result.upsertNodes[0]), "note");
  assert.match(inspectRevision(result, ctx).reasons.join(), /缺少 note/);
});

test("unchanged 和 needs_plan 只带说明，不接受差量字段", () => {
  const ctx = context(), { summary, review } = patch(ctx);
  for (const kind of ["unchanged", "needs_plan"]) {
    assert.deepEqual(inspectRevision({ kind, summary, review }, ctx), { reasons: [] });
    assert.match(inspectRevision({ kind, summary, review, upsertNodes: [] }, ctx).reasons.join(), /不允许字段 upsertNodes/);
  }
});

test("差量中的不存在删除、重复更新、同名删除更新和空改动都拒绝", () => {
  const ctx = context();
  for (const [mutate, why] of mutations([
    [(result) => result.removeNodes.push("不存在"), /删除不存在的节点/],
    [(result) => result.upsertNodes.push(present(result.upsertNodes[0])), /重复提交 抽/],
    [(result) => result.removeNodes.push("写"), /不能同时删除和更新/],
    [(result) => result.removeEdges.push({ from: "读", to: "写" }), /删除不存在的线/],
    [(result) => result.addEdges.push(present(ctx.canvas.edges[0])), /重复添加/],
    [(result) => { result.upsertNodes = [structuredClone(revisionNode(ctx.canvas.nodes[2]))]; }, /没有实际改动/],
  ])) {
    const result = patch(ctx); mutate(result);
    const checked = inspectRevision(result, ctx);
    assert.match(checked.reasons.join(), why);
    assert.equal(checked.candidate, undefined);
  }
});

test("发起节点不能被删除或转移步骤，其他节点只能属于现有步骤", () => {
  const ctx = context(), result = patch(ctx);
  result.upsertNodes = result.upsertNodes.slice(1);
  result.removeNodes = ["抽"];
  assert.match(inspectRevision(result, ctx).reasons.join(), /发起指令的节点必须保留/);
  result.removeNodes = [];
  result.upsertNodes = [{ ...revisionNode(ctx.canvas.nodes[2]), step: "s4" }];
  assert.match(inspectRevision(result, ctx).reasons.join(), /不能转移所属步骤/);
  result.upsertNodes = [{ ...revisionNode(ctx.canvas.nodes[4]), step: "s9" }];
  assert.match(inspectRevision(result, ctx).reasons.join(), /方案里没有的步骤 s9/);
});

test("整图拒绝悬空边、缺少某一步、缺依赖线和节点环", () => {
  const ctx = context();
  for (const [mutate, why] of mutations([
    [(result) => result.addEdges.push({ from: "抽", to: "不存在" }), /不存在的节点/],
    [(result) => { result.upsertNodes = result.upsertNodes.slice(0, 1); result.removeNodes = ["写"]; result.removeEdges = [present(ctx.canvas.edges[3])]; }, /s5 在画布上没有节点/],
    [(result) => result.removeEdges.push(present(ctx.canvas.edges[3])), /没有一条线从 s4 接到 s5/],
    [(result) => result.addEdges.push({ from: "写", to: "抽" }), /存在环/],
  ])) {
    const result = patch(ctx); mutate(result);
    assert.match(inspectRevision(result, ctx).reasons.join(), why);
  }
});

test("允许跨步骤重接完整差量，新增同一步节点无需套用单步提交协议", () => {
  const ctx = context(), result = patch(ctx);
  result.upsertNodes.push(node("格式化", "s3", "code", { code: "return items;", outputKind: "JSON" }));
  result.removeEdges = [present(ctx.canvas.edges[2])];
  result.addEdges = [{ from: "抽", to: "格式化" }, { from: "格式化", to: "算" }];
  const checked = inspectRevision(result, ctx);
  assert.deepEqual(checked.reasons, []);
  assert.equal(present(checked.candidate).nodes.length, 6);
  assert.ok(present(checked.changes).includes("算"), "边改动端点也出现在影响节点列表中");
});

test("同一步不能加入孤立 code，只有共同下游也不算连好", () => {
  const ctx = context(), result = patch(ctx);
  result.upsertNodes.push(node("孤立计算", "s3", "code", { code: "return items;", outputKind: "JSON" }));
  let checked = inspectRevision(result, ctx);
  assert.match(checked.reasons.join(), /s3 的节点 孤立计算.*没跟这一步的其他节点连在一起/);
  assert.equal(checked.candidate, undefined);
  result.addEdges.push({ from: "孤立计算", to: "算" });
  checked = inspectRevision(result, ctx);
  assert.match(checked.reasons.join(), /孤立计算.*没跟这一步的其他节点连在一起/);
  assert.equal(checked.candidate, undefined);
});

test("同一步分支共享上游即连成一片，不要求分支之间另接一条线", () => {
  const ctx = context(), result = patch(ctx);
  result.upsertNodes.push(node("并行计算", "s3", "code", { code: "return items;", outputKind: "JSON" }));
  result.addEdges.push({ from: "解", to: "并行计算" });
  const checked = inspectRevision(result, ctx);
  assert.deepEqual(checked.reasons, []);
  assert.equal(present(checked.candidate).nodes.length, 6);
});

test("方案有多个独立根步骤时，不强迫两条流程互相连接", () => {
  const ctx = context();
  ctx.plan.steps.push(present(planWithSteps([{ ref: "s6", dependsOn: [] }]).steps[0]));
  ctx.canvas.nodes.push(node("其他目录", "s6", "readFile", {}, ["folder"]));
  const checked = inspectRevision(patch(ctx), ctx);
  assert.deepEqual(checked.reasons, []);
  assert.equal(present(checked.candidate).nodes.length, 6);
});

test("边 key 不会把节点名中的分隔符当成结构", () => {
  const ctx = context(), result = patch(ctx);
  result.upsertNodes.push(node("a>b", "s3", "code", { code: "return items;", outputKind: "JSON" }));
  result.addEdges.push({ from: "抽", to: "a>b" });
  assert.deepEqual(inspectRevision(result, ctx).reasons, []);
});

test("字段语义没有机器保证：total 替换 amount 仍属于 JSON，review 不是字段证明", () => {
  const ctx = context(), result = patch(ctx);
  present(result.upsertNodes[0]).params.outputSchema = { type: "object", properties: { total: { type: "number" } } };
  assert.deepEqual(inspectRevision(result, ctx).reasons, []);
});
