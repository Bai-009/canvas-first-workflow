import { test } from "node:test";
import assert from "node:assert/strict";
import { present, readPlan } from "../helpers/fixtures.mjs";
import type { AssistantMessage, Message } from "../../shared/model.mjs";
import { runPlanAgent, loadSystemPrompt } from "../../src/plan/plan-agent.mjs";

const goodPlan = readPlan(new URL("../../fixtures/contract-processing.plan.json", import.meta.url));

function replyWithPlan(plan: unknown, speech = "先说一段话。"): AssistantMessage {
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

function fakeModel(replies: AssistantMessage[]) {
  const calls: Message[][] = [];
  return {
    calls,
    async callModel(messages: Message[]) {
      calls.push(messages);
      return present(replies.shift());
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

/* 真模型实录:Kimi K3 有时候不走工具,把整份方案当正文写出来,
   开头是一段 <invoke name="propose_plan">。那一轮方案没交上来,
   而正文是给机器看的一坨——不能当成「它只想说句话」原样收下。 */
test("方案写在正文里没走工具:当成没交,让它重来,XML 不进给人看的那段话", async () => {
  const inText: AssistantMessage = {
    role: "assistant",
    content: '按整份 PDF 探测有无文字层。\n\n<invoke name="propose_plan">{"readiness":"partial"}</invoke>',
  };
  const fake = fakeModel([inText, replyWithPlan(goodPlan, "")]);
  const result = await runPlanAgent({
    callModel: fake.callModel,
    messages: [{ role: "user", content: "把合同 PDF 转成向量" }],
  });
  assert.deepEqual(result.plan, goodPlan);
  assert.equal(fake.calls.length, 2);
  assert.equal(result.speech, "按整份 PDF 探测有无文字层。");
  assert.doesNotMatch(result.speech, /invoke/);
  /* calls 存的是同一个数组的引用,后面还会被追加,所以往回找最后一条 user。 */
  const nudge = [...present(fake.calls[1])].reverse().find((m) => m.role === "user");
  assert.match(present(nudge?.content), /没有经过 propose_plan/);
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
  const feedback = present(fake.calls[1]).find((m) => m.role === "tool");
  assert.match(present(feedback?.content), /没过校验/);
  assert.match(present(feedback?.content), /extra/);
});

/* 真模型实录(run5):第一次提交多了个字段被打回,重交时一句话没说。
   给人看的那段话在第一次里,不能因为重交而丢。 */
test("闸门打回重交时,第一次说的话不丢", async () => {
  const badPlan = { ...goodPlan, description: "多出来的字段" };
  const fake = fakeModel([
    replyWithPlan(badPlan, "我先按带文字层来画,扫描件留成了选项。"),
    replyWithPlan(goodPlan, ""),
  ]);
  const result = await runPlanAgent({
    callModel: fake.callModel,
    messages: [{ role: "user", content: "每天同步新增合同" }],
  });
  assert.deepEqual(result.plan, goodPlan);
  assert.match(result.speech, /带文字层/);
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
  const receipt = present(transcript.at(-1));
  assert.equal(receipt.role, "tool");
  assert.match(present(receipt.content), /通过校验/);
});

/* 英文版是译本,不是另一份提示词:分节要和中文一一对应,少一节就是翻译丢了东西。 */
test("中英两版提示词分节一一对应,都指向同一个工具和字段", () => {
  const sections = (text: string) => [...text.matchAll(/^<([^/][^>]*)>$/gm)].map((m) => m[1]);
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
  const first = present(transcript[0]);
  assert.equal(first.role, "system");
  assert.match(present(first.content), /<role>/);
});

test("不存在的提示词版本直接报错,不悄悄退回中文", () => {
  assert.throws(() => loadSystemPrompt("fr"), /没有 fr 这一版/);
});
