import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runPlanAgent, loadSystemPrompt } from "../src/plan-agent.mjs";

const goodPlan = JSON.parse(
  readFileSync(new URL("../fixtures/contract-processing.plan.json", import.meta.url), "utf8")
);

function replyWithPlan(plan, speech = "先说一段话。") {
  return {
    role: "assistant",
    content: speech,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "propose_plan", arguments: JSON.stringify(plan) },
      },
    ],
  };
}

function fakeModel(replies) {
  const calls = [];
  return {
    calls,
    async callModel(messages) {
      calls.push(messages);
      return replies.shift();
    },
  };
}

test("模型只说话不提交,循环原样收下,不算失败", async () => {
  const fake = fakeModel([{ role: "assistant", content: "你手上的数据现在是什么形态?" }]);
  const result = await runPlanAgent({
    callModel: fake.callModel,
    messages: [{ role: "user", content: "帮我搞个工作流" }],
  });
  assert.equal(result.plan, null);
  assert.match(result.speech, /形态/);
  assert.equal(fake.calls.length, 1);
});

test("坏方案被闸门打回,错误发回模型,重交好的就收下", async () => {
  const badPlan = { ...goodPlan, extra: "schema 里没有的字段" };
  const fake = fakeModel([replyWithPlan(badPlan), replyWithPlan(goodPlan, "改好了。")]);
  const result = await runPlanAgent({
    callModel: fake.callModel,
    messages: [{ role: "user", content: "每天同步新增合同" }],
  });
  assert.deepEqual(result.plan, goodPlan);
  assert.equal(fake.calls.length, 2);
  const feedback = fake.calls[1].find((m) => m.role === "tool");
  assert.match(feedback.content, /没过校验/);
  assert.match(feedback.content, /extra/);
});

test("连续交坏方案,超过重试上限就停,不无限打转", async () => {
  const badPlan = { ...goodPlan, readiness: "blocked" };
  const fake = fakeModel([
    replyWithPlan(badPlan),
    replyWithPlan(badPlan),
    replyWithPlan(badPlan),
    replyWithPlan(badPlan),
  ]);
  await assert.rejects(
    runPlanAgent({
      callModel: fake.callModel,
      messages: [{ role: "user", content: "每天同步新增合同" }],
    }),
    /停止重试/
  );
  assert.equal(fake.calls.length, 4);
});

test("过闸的方案会收到确认回执,对话能接着往下走", async () => {
  const fake = fakeModel([replyWithPlan(goodPlan)]);
  const { transcript } = await runPlanAgent({
    callModel: fake.callModel,
    messages: [{ role: "user", content: "每天同步新增合同" }],
  });
  const receipt = transcript.at(-1);
  assert.equal(receipt.role, "tool");
  assert.match(receipt.content, /通过校验/);
});

/* 英文版是译本,不是另一份提示词:分节要和中文一一对应,少一节就是翻译丢了东西。 */
test("中英两版提示词分节一一对应,都指向同一个工具和字段", () => {
  const sections = (text) => [...text.matchAll(/^<([^/][^>]*)>$/gm)].map((m) => m[1]);
  const zh = sections(loadSystemPrompt("zh"));
  const en = sections(loadSystemPrompt("en"));
  assert.ok(zh.length > 0);
  assert.equal(en.length, zh.length);
  for (const text of [loadSystemPrompt("zh"), loadSystemPrompt("en")]) {
    assert.match(text, /propose_plan/);
    assert.match(text, /readiness/);
    assert.match(text, /understanding/);
    assert.match(text, /openQuestions/);
  }
});

test("指定哪一版提示词,它就进对话记录的第一条", async () => {
  const fake = fakeModel([{ role: "assistant", content: "What shape is your data in right now?" }]);
  const { transcript } = await runPlanAgent({
    callModel: fake.callModel,
    messages: [{ role: "user", content: "build me a workflow" }],
    systemPrompt: loadSystemPrompt("en"),
  });
  assert.equal(transcript[0].role, "system");
  assert.match(transcript[0].content, /<role>/);
});

test("不存在的提示词版本直接报错,不悄悄退回中文", () => {
  assert.throws(() => loadSystemPrompt("fr"), /没有 fr 这一版/);
});
