import { test } from "node:test";
import assert from "node:assert/strict";
import { readPlan } from "../helpers/fixtures.mjs";
import { diffPlans } from "../../src/plan/plan-diff.mjs";

const read = (rel: string) => readPlan(new URL(rel, import.meta.url));
const before = read("../../fixtures/observed/run4-修订轮/turn-1.plan.json");
const after = read("../../fixtures/observed/run4-修订轮/turn-2.plan.json");

test("修订轮实录:s1 s2 原地改,s3 s4 沿用,q1 q2 消失,u5 u6 新增", () => {
  const d = diffPlans(before, after);
  assert.deepEqual(d.steps, { kept: ["s3", "s4"], changed: ["s1", "s2"], added: [], removed: [] });
  assert.deepEqual(d.openQuestions.removed, ["q1", "q2"]);
  assert.deepEqual(d.openQuestions.kept, ["q3", "q4"]);
  assert.deepEqual(d.understanding.added, ["u5", "u6"]);
  assert.deepEqual(d.understanding.changed, ["u2"]);
});

test("键的顺序不算差异", () => {
  const reordered = {
    ...after,
    steps: after.steps.map(({ ref, title, intent, input, output, dependsOn }) => ({
      dependsOn, output, input, intent, title, ref,
    })),
  };
  assert.deepEqual(diffPlans(after, reordered).steps.changed, []);
  assert.equal(diffPlans(after, reordered).steps.kept.length, 4);
});

test("没有上一版的时候,全部算新增", () => {
  const d = diffPlans(null, before);
  assert.equal(d.steps.added.length, 4);
  assert.equal(d.steps.kept.length, 0);
});
