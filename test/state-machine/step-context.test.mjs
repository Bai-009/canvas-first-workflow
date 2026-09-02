import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stepOrder, questionsFor, assembleTable } from "../../src/state-machine/step-context.mjs";

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const run8 = read("../../fixtures/observed/run8-原因版提示词/turn-2.plan.json");

test("run8 四步按接在谁后面排成 s1 s2 s3 s4", () => {
  assert.deepEqual(stepOrder(run8), ["s1", "s2", "s3", "s4"]);
});

test("分叉再合流:前序都走过了才走,同时可走的按方案里的先后", () => {
  const plan = {
    steps: [
      { ref: "s1", dependsOn: [] },
      { ref: "s2", dependsOn: ["s1"] },
      { ref: "s3", dependsOn: ["s1"] },
      { ref: "s4", dependsOn: ["s2", "s3"] },
    ],
  };
  assert.deepEqual(stepOrder(plan), ["s1", "s2", "s3", "s4"]);
  const shuffled = { steps: [plan.steps[3], plan.steps[2], plan.steps[1], plan.steps[0]] };
  assert.deepEqual(stepOrder(shuffled), ["s1", "s3", "s2", "s4"]);
});

test("接了不存在的编号、或者绕成圈,报错而不是死循环", () => {
  assert.throws(
    () => stepOrder({ steps: [{ ref: "s1", dependsOn: ["s9"] }] }),
    /方案里没有 s9/
  );
  assert.throws(
    () =>
      stepOrder({
        steps: [
          { ref: "s1", dependsOn: ["s2"] },
          { ref: "s2", dependsOn: ["s1"] },
        ],
      }),
    /互相等着.*s1、s2/
  );
});

test("问题按影响到哪几步挂到步骤上:s3 挂 q3,s4 挂 q4,s1 s2 没有", () => {
  assert.deepEqual(questionsFor(run8, "s1"), []);
  assert.deepEqual(questionsFor(run8, "s2"), []);
  assert.deepEqual(questionsFor(run8, "s3").map((q) => q.ref), ["q3"]);
  assert.deepEqual(questionsFor(run8, "s4").map((q) => q.ref), ["q4"]);
});

test("s1 开工时桌上五样:整份方案、这一步、画布、没有问题、没有批注", () => {
  const canvas = { nodes: [], edges: [], version: 0 };
  const table = assembleTable(run8, "s1", { canvas });
  assert.deepEqual(Object.keys(table), ["plan", "step", "canvas", "openQuestions", "instructions"]);
  assert.deepEqual(table.plan, run8);
  assert.equal(table.step.ref, "s1");
  assert.deepEqual(table.canvas, canvas);
  assert.deepEqual(table.openQuestions, []);
  assert.deepEqual(table.instructions, []);
});

test("s3 开工时桌上有 q3;批注只有挂在这一步上的那些", () => {
  const annotations = [
    { step: "s1", text: "PDF 太大,先拆成单页图片再往下送" },
    { step: "s3", text: "金额字段要带币种" },
  ];
  const table = assembleTable(run8, "s3", { canvas: { nodes: [], edges: [], version: 0 }, annotations });
  assert.deepEqual(table.openQuestions.map((q) => q.ref), ["q3"]);
  assert.deepEqual(table.instructions, ["金额字段要带币种"]);
  assert.deepEqual(assembleTable(run8, "s1", { canvas: {}, annotations }).instructions, [
    "PDF 太大,先拆成单页图片再往下送",
  ]);
});

test("桌上的东西是副本,执行者改了不伤账本", () => {
  const canvas = { nodes: [], edges: [], version: 0 };
  const table = assembleTable(run8, "s1", { canvas });
  table.plan.steps[0].title = "改坏了";
  table.canvas.nodes.push({});
  assert.equal(run8.steps[0].title, "圈定昨日落库的合同 PDF");
  assert.equal(canvas.nodes.length, 0);
});

test("要一个方案里没有的步,报错", () => {
  assert.throws(() => assembleTable(run8, "s9", { canvas: {} }), /没有 s9 这一步/);
});
