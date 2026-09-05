import type { AssistantMessage, Message, CallOptions } from "../../shared/model.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { present, readPlan } from "../helpers/fixtures.mjs";
import { createPlanSession } from "../../src/plan/plan-session.mjs";

const read = (rel: string) => readPlan(new URL(rel, import.meta.url));
const v1 = read("../../fixtures/observed/run4-修订轮/turn-1.plan.json");
const v2 = read("../../fixtures/observed/run4-修订轮/turn-2.plan.json");

let callCounter = 0;
const submit = (plan: unknown, content = ""): AssistantMessage => ({
  role: "assistant",
  content,
  tool_calls: [
    {
      id: `call_${++callCounter}`,
      type: "function",
      function: { name: "propose_plan", arguments: JSON.stringify(plan) },
    },
  ],
});
const speak = (content: string): AssistantMessage => ({ role: "assistant", content });

/* 剧本式假模型:每次调用按顺序吐一条;条目是函数的话,把 signal 交给它,好演"跑着被停掉"。 */
function scripted(replies: (AssistantMessage | ((signal?: AbortSignal) => Promise<AssistantMessage>))[]) {
  const seen: Message[][] = [];
  return {
    seen,
    async callModel(messages: Message[], { signal }: CallOptions = {}) {
      seen.push(structuredClone(messages)); // 快照:循环之后还会往这同一个数组里追加
      const next = present(replies.shift());
      return typeof next === "function" ? next(signal) : next;
    },
  };
}

const hang = (signal?: AbortSignal) =>
  new Promise<AssistantMessage>((_, reject) => {
    present(signal).addEventListener("abort", () => reject(new DOMException("停了", "AbortError")));
  });

test("过闸的一轮换掉当前方案,版本加一,差异按编号算出来", async () => {
  const fake = scripted([submit(v1), submit(v2)]);
  const session = createPlanSession({ callModel: fake.callModel });
  assert.equal(session.currentPlan, null);

  const first = await session.say("每天定时把新增的合同 PDF 解析出关键字段,写进数据库");
  assert.equal(session.revision, 1);
  assert.deepEqual(session.currentPlan, v1);
  assert.equal(first.diff, null);

  const second = await session.say("PDF 都是扫描件。「新增」按文件落库时间算,每天处理昨天落库的。");
  assert.equal(session.revision, 2);
  assert.deepEqual(session.currentPlan, v2);
  assert.deepEqual(present(second.diff).openQuestions.removed, ["q1", "q2"]);
  assert.deepEqual(present(second.diff).steps.changed, ["s1", "s2"]);
});

test("第二轮交给模型的记录里带着第一轮的工具调用和闸门回执", async () => {
  const fake = scripted([submit(v1), submit(v2)]);
  const session = createPlanSession({ callModel: fake.callModel });
  await session.say("一");
  await session.say("二");
  const roles = present(fake.seen[1]).map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool", "user"]);
  const receipt = present(present(fake.seen[1])[3]);
  assert.match(present(receipt.content), /收下/);
});

test("只说话的一轮不碰当前方案,记录照样变长", async () => {
  const fake = scripted([submit(v1), speak("再确认一下,PDF 是扫描件吗?")]);
  const session = createPlanSession({ callModel: fake.callModel });
  await session.say("一");
  const turn = await session.say("二");
  assert.equal(turn.plan, null);
  assert.match(turn.speech, /扫描件/);
  assert.equal(session.revision, 1);
  assert.deepEqual(session.currentPlan, v1);
  assert.equal(session.transcript.length, 5);
});

test("一轮在跑的时候不收第二句", async () => {
  let release: (() => void) | undefined;
  const fake = scripted([() => new Promise((resolve) => { release = () => resolve(submit(v1)); })]);
  const session = createPlanSession({ callModel: fake.callModel });
  const pending = session.say("第一句");
  assert.equal(session.running, true);
  await assert.rejects(session.say("第二句"), /先停掉/);
  present(release)();
  await pending;
  assert.equal(session.running, false);
  assert.equal(session.revision, 1);
});

test("停掉正在跑的一轮:当前方案不动,记录只留用户那句,之后还能接着聊", async () => {
  const fake = scripted([submit(v1), hang, submit(v2)]);
  const session = createPlanSession({ callModel: fake.callModel });
  await session.say("一");

  const pending = session.say("二");
  assert.equal(session.stop(), true);
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(session.running, false);
  assert.equal(session.revision, 1);
  assert.deepEqual(session.currentPlan, v1);
  assert.equal(present(session.transcript.at(-1)).content, "二");
  assert.equal(session.stop(), false);

  await session.say("三");
  assert.equal(session.revision, 2);
  const roles = present(fake.seen[2]).map((m) => m.role);
  assert.deepEqual(roles.slice(-2), ["user", "user"]);
});

test("几次都没过闸:报错,当前方案不动", async () => {
  const bad = { ...v1, readiness: "blocked" };
  const fake = scripted([submit(v1), submit(bad), submit(bad), submit(bad), submit(bad)]);
  const session = createPlanSession({ callModel: fake.callModel });
  await session.say("一");
  await assert.rejects(session.say("二"), /停止重试/);
  assert.equal(session.revision, 1);
  assert.deepEqual(session.currentPlan, v1);
  assert.equal(present(session.transcript.at(-1)).content, "二");
});
