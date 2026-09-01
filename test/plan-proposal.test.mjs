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

test("合同处理 partial Plan 通过 Gate", () => {
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

test("拒绝 Plan Agent 越权输出 WorkItem", () => {
  const proposal = clone(fixture);
  proposal.steps[0].workItem = "volume_file_watch@1.3.0";
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /不是允许的字段/);
});

test("拒绝 Plan Agent 越权指定节点数量", () => {
  const proposal = clone(fixture);
  proposal.steps[2].nodeCount = 3;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /不是允许的字段/);
});

test("ready Plan 不能同时保留开放问题", () => {
  const proposal = clone(fixture);
  proposal.readiness = "ready";
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /不能保留 openQuestions/);
});

test("开放问题只能影响真实存在的步骤", () => {
  const proposal = clone(fixture);
  proposal.openQuestions[0].affects = ["s9"];
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /引用了不存在的步骤/);
});

test("每一步都必须说明自己交出什么", () => {
  const proposal = clone(fixture);
  delete proposal.steps[2].output;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /output 必须是非空字符串/);
});

test("依赖了前序步骤就必须说明自己吃什么", () => {
  const proposal = clone(fixture);
  delete proposal.steps[3].input;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /没有说明它吃什么/);
});

test("链路起点可以没有 input", () => {
  const proposal = clone(fixture);
  assert.equal("input" in proposal.steps[0], false);
  assert.equal(validatePlanProposal(proposal).ok, true);
});

test("理解条目的编号不能重复", () => {
  const proposal = clone(fixture);
  proposal.understanding[1].ref = proposal.understanding[0].ref;
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /与其他理解重复/);
});

test("理解条目必须带上用户原话", () => {
  const proposal = clone(fixture);
  proposal.understanding[0].quote = "";
  const result = validatePlanProposal(proposal);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /quote 必须是非空字符串/);
});
