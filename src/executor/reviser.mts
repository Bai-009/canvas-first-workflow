import type { RevisionResult } from '../../shared/contracts.mjs';
import type { ModelCaller, Message, ToolCall } from '../../shared/model.mjs';
import type { RevisionContext, AgentEvent, AgentTiming, AgentOptions } from '../../shared/workflow.mjs';
import { errorMessage, errorDetails } from '../../shared/errors.mjs';
interface RevisionOptions {
  callModel: ModelCaller;
  systemPrompt?: string;
  maxRounds?: number;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: AgentEvent) => void) | undefined;
}
interface RevisionOutcome {
  result: RevisionResult;
  messages: Message[];
  events: AgentEvent[];
  rounds: number;
  timing: AgentTiming;
}
interface FactoryOptions {
  callModel: ModelCaller;
  systemPrompt?: string;
  maxRounds?: number;
  onEvent?: ((event: AgentEvent, context: RevisionContext) => void) | undefined;
  save?: string | undefined;
}
/* 一次用户要求,审查整张画布,只交必要 diff。调用循环不提交画布、不改方案。
   提交前和状态机提交时用同一道闸门,被退的候选不会成为下一轮的画布。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { renderNodeTable } from "./node-catalog.mjs";
import { submitRevisionTool } from "./submit-revision-tool.mjs";
import { readRevision } from "../state-machine/workflow-revision.mjs";
import { callerFromEnv } from "../model/openai-compatible.mjs";

export const reviserTools = [submitRevisionTool];

export function loadRevisionPrompt() {
  return readFileSync(new URL("../../prompts/reviser.en.md", import.meta.url), "utf8")
    .replace("{{node_table}}", renderNodeTable());
}

/* 不按 target 裁剪任何一项:目标卡是发起点,计划、画布和历史都是整份。 */
export function revisionMessage(context: RevisionContext) {
  const block = (tag: string, value: unknown) => `<${tag}>\n${JSON.stringify(value, null, 2)}\n</${tag}>`;
  return [
    block("plan", context.plan),
    block("canvas", context.canvas),
    block("target", context.target),
    block("instruction", context.instruction),
    block("requirements", context.requirements ?? []),
    block("annotations", context.annotations ?? []),
    block("history", context.history ?? { runs: [], edits: [] }),
  ].join("\n\n");
}

function assertRunning(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("整图修订已停止", { cause: signal.reason });
  error.name = "AbortError";
  throw error;
}

const toolReply = (call: ToolCall, answer: unknown): Message => ({ role: "tool", tool_call_id: call.id, content: JSON.stringify(answer) });
const WROTE_IT_OUT = /<(?:invoke|function_calls|antml:invoke)\b|\bsubmit_revision\s*\(/i;

export async function runRevision(context: RevisionContext, {
  callModel, systemPrompt = loadRevisionPrompt(), maxRounds = 8, signal, onEvent = () => {},
}: RevisionOptions): Promise<RevisionOutcome> {
  const snapshot = structuredClone(context);
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: revisionMessage(snapshot) },
  ];
  const events: AgentEvent[] = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const timing = (status: AgentTiming["status"], rounds: number): AgentTiming => ({ startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - started, status, rounds });
  const note = (event: AgentEvent) => { events.push(event); onEvent(event); };
  let round = 0;

  try {
    if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("maxRounds 必须是正整数");
    for (round = 1; round <= maxRounds; round++) {
      assertRunning(signal);
      const reply = await callModel(messages, { signal, tools: reviserTools });
      if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("模型没有返回有效的消息对象");
      messages.push(reply);
      /* 模型接口可能忽略取消,或者取消与返回同时到。晚到的结果仍不能成功交出。 */
      assertRunning(signal);
      if (reply.content) note({ round, kind: "said", text: reply.content });
      const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
      if (!calls.length) {
        const wrote = WROTE_IT_OUT.test(reply.content ?? "");
        note({ round, kind: "no-call", wrote });
        messages.push({
          role: "user",
          content: wrote
            ? "上一条把 submit_revision 写在正文里了,那不是一次调用,没有被收到。请真正调用 submit_revision 交回整图检查后的候选修订。"
            : "这一轮没有调用工具,没有收到修订候选。请检查整张画布并调用 submit_revision,只提交必要 diff;无需改动用 unchanged,需要改方案用 needs_plan。",
        });
        continue;
      }
      if (calls.length !== 1) {
        const reasons = ["一次只提交一个完整修订候选,不能在同一条消息里调用多个工具;这些调用均未提交画布"];
        for (const call of calls) messages.push(toolReply(call, { rejected: reasons }));
        note({ round, kind: "rejected", reasons });
        continue;
      }
      const call = calls[0];
      if (!call) throw new Error("模型没有返回有效的工具调用");
      const name = call.function?.name;
      if (name !== "submit_revision") {
        const answer = { error: `unknown tool ${name}; the only tool is submit_revision. This request reviews the whole canvas, not submit_step.` };
        messages.push(toolReply(call, answer));
        note({ round, kind: "tool", tool: name, answer });
        continue;
      }
      let result: unknown;
      try {
        result = JSON.parse(call.function?.arguments ?? "");
      } catch (error) {
        const answer = { error: `arguments is not valid JSON: ${errorMessage(error)}; submit the complete candidate again` };
        messages.push(toolReply(call, answer));
        note({ round, kind: "bad-args", tool: name, reason: answer.error });
        continue;
      }
      assertRunning(signal);
      const inspection = readRevision(result, snapshot);
      if (!inspection.ok) {
        const reasons = inspection.reasons;
        messages.push(toolReply(call, { rejected: reasons }));
        note({ round, kind: "rejected", reasons });
        continue;
      }
      assertRunning(signal);
      messages.push(toolReply(call, { accepted: true, committed: false, kind: inspection.result.kind }));
      note({ round, kind: "submitted", submission: result });
      assertRunning(signal);
      return { result: inspection.result, messages, events, rounds: round, timing: timing("accepted", round) };
    }
    assertRunning(signal);
    throw new Error(`整图修订来回 ${maxRounds} 次没有有效提交,画布未改变`);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    throw Object.assign(error, {
      messages, events,
      timing: timing(signal?.aborted || error.name === "AbortError" ? "stopped" : "failed", Math.min(round, maxRounds)),
    });
  }
}

export function createReviser({ callModel, systemPrompt = loadRevisionPrompt(), maxRounds = 8, onEvent, save }: FactoryOptions) {
  let count = 0;
  return async function revise(context: RevisionContext, { signal }: AgentOptions = {}) {
    const snapshot = structuredClone(context);
    const dir = save ? join(save, String(++count).padStart(2, "0")) : null;
    const keep = (name: string, value: unknown) => {
      if (!dir || value === undefined) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    };
    keep("context.json", snapshot);
    let outcome: RevisionOutcome | undefined;
    try {
      outcome = await runRevision(snapshot, {
        callModel, systemPrompt, maxRounds, signal,
        onEvent: onEvent ? (event) => onEvent(event, snapshot) : undefined,
      });
      assertRunning(signal);
      keep("messages.json", outcome.messages);
      keep("events.json", outcome.events);
      keep("submission.json", outcome.result);
      keep("timing.json", outcome.timing);
      return outcome.result;
    } catch (error) {
      /* 取消可能发生在循环完成和外层恢复之间,这时仍保留刚收到的完整实录。 */
      keep("messages.json", errorDetails(error).messages ?? outcome?.messages);
      keep("events.json", errorDetails(error).events ?? outcome?.events);
      keep("error.txt", `${errorMessage(error)}\n`);
      keep("timing.json", errorDetails(error).timing ?? (outcome && { ...outcome.timing, status: signal?.aborted ? "stopped" : "failed" }));
      throw error;
    }
  };
}

let plugged: ReturnType<typeof createReviser> | null = null;
export default async function revise(context: RevisionContext, options?: AgentOptions) {
  if (!plugged) {
    const where = process.env.EXECUTOR_SAVE ?? ".runs";
    const save = where === "none" ? undefined : join(where, `revision-${Date.now()}-${process.pid}-${randomUUID()}`);
    plugged = createReviser({ callModel: callerFromEnv(process.env, { tools: reviserTools }), save });
  }
  return plugged(context, options);
}
