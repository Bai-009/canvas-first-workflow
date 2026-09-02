import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatePlanProposal } from "../src/validate-plan-proposal.mjs";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/contract-processing.plan.json", import.meta.url), "utf8")
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("合同处理的骨架方案能通过闸门", () => {
  assert.deepEqual(validatePlanProposal(fixture), { ok: true, errors: [] });
});

test("拒绝引用不存在的依赖", () => {
  const proposal = clone(fixture);
  proposal.steps[1].dependsOn = ["missing_step"];
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /不存在的依赖/);
});

test("拒绝循环依赖", () => {
  const proposal = clone(fixture);
  proposal.steps[0].dependsOn = ["s4"];
  proposal.steps[0].input = "入库结果";
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /依赖存在环/);
});

test("拒绝设计者越权挑选 WorkItem", () => {
  const proposal = clone(fixture);
  proposal.steps[0].workItem = "volume_file_watch@1.3.0";
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /schema 里没有的字段/);
});

test("拒绝设计者越权指定用几个节点", () => {
  const proposal = clone(fixture);
  proposal.steps[2].nodeCount = 3;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /schema 里没有的字段/);
});

test("说能直接跑，就不该还留着没问清的信息", () => {
  const proposal = clone(fixture);
  proposal.readiness = "ready";
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /不该还留着没问清的信息/);
});

test("缺口只能挂在真实存在的环节上", () => {
  const proposal = clone(fixture);
  proposal.openQuestions[0].affects = ["s9"];
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /引用了不存在的步骤/);
});

test("每一环都必须说明数据出去时变成什么", () => {
  const proposal = clone(fixture);
  delete proposal.steps[2].output;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /缺少必填字段：output/);
});

test("每一环都必须说明数据进来时是什么", () => {
  const proposal = clone(fixture);
  delete proposal.steps[3].input;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /缺少必填字段：input/);
});

/* 起点的 input 是整条链的地基——用户手上现在有的是什么形态的数据。
   它比中间任何一环的 input 都更不能省。 */
test("链路起点也必须说明数据形态", () => {
  const proposal = clone(fixture);
  delete proposal.steps[0].input;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /缺少必填字段：input/);
});

test("能不能跑只有两种取值，blocked 已经砍掉", () => {
  const proposal = clone(fixture);
  proposal.readiness = "blocked";
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /取值不在允许范围内/);
});

test("回读条目的编号不能重复", () => {
  const proposal = clone(fixture);
  proposal.understanding[1].ref = proposal.understanding[0].ref;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /与其他理解重复/);
});

test("回读必须带上用户原话", () => {
  const proposal = clone(fixture);
  proposal.understanding[0].quote = "";
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /不能是空字符串/);
});

/* 备选项是被真模型逼出来的:首轮它在 q2 的问题文本里自己塞了三个选项,没地方放。 */
test("问题可以带备选项,用户可选可写", () => {
  const proposal = clone(fixture);
  proposal.openQuestions[0].options = ["按文件落库时间", "按文件名", "按合同编号去重"];
  assert.deepEqual(validatePlanProposal(proposal), { ok: true, errors: [] });
});

test("备选项不能重复,也不能是空串", () => {
  const duplicated = clone(fixture);
  duplicated.openQuestions[0].options = ["扫描件", "扫描件"];
  assert.equal(validatePlanProposal(duplicated).ok, false);
  const blank = clone(fixture);
  blank.openQuestions[0].options = [""];
  assert.equal(validatePlanProposal(blank).ok, false);
});
