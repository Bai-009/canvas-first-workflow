/* 执行者本体:一步的来回。
   桌上的五样贴上标签发给模型,整张节点表常驻在提示词里,只带一个工具(交);
   它一交,交的东西先过状态机那道闸门(同一道,不另造:信封 + 对得上节点表),过了就还给状态机,没过就把原因退给它再来。
   来回有上限;说话不交也算没交。 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderNodeTable } from "./node-catalog.mjs";
import { submitStepTool } from "./submit-step-tool.mjs";
import { checkResult } from "../state-machine/workflow-session.mjs";
import { callerFromEnv as modelCallerFromEnv } from "../model/openai-compatible.mjs";

export const executorTools = [submitStepTool];

/* 提示词文件里 {{node_table}} 那一行换成整张节点表:表改了提示词跟着改,不抄第二份 */
export function loadSystemPrompt() {
  const text = readFileSync(new URL("../../prompts/executor.en.md", import.meta.url), "utf8");
  return text.replace("{{node_table}}", renderNodeTable());
}

export function callerFromEnv(env = process.env) {
  return modelCallerFromEnv(env, { tools: executorTools });
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/* 五样贴标签。画布原样发:节点的名字全线只有 name 一个叫法,这里不换。 */
export function stepMessage(context) {
  const { plan, step, canvas, openQuestions, instructions } = context;
  const block = (tag, value) => `<${tag}>\n${JSON.stringify(value, null, 2)}\n</${tag}>`;
  return [
    block("plan", plan),
    block("step", step),
    block("canvas", { nodes: canvas.nodes, edges: canvas.edges }),
    block("open_questions", openQuestions),
    block("annotations", instructions),
  ].join("\n\n");
}

/* 模型交的 → 状态机认的。这一层只拥有一样东西:节点属于哪一步(step),所以只补这一样,
   其余原样带过去。路过的层不许挑格子——挑一次,以后契约上新加的格子就在这儿悄没声地没了。
   形状不对的也原样递过去,让闸门说话。 */
export function toPatch(submission, ref) {
  if (!isObject(submission)) return submission;
  if (submission.kind === "covered") return { kind: "covered" };
  const nodes = Array.isArray(submission.nodes)
    ? submission.nodes.map((node) => (isObject(node) ? { ...node, step: ref } : node))
    : submission.nodes;
  return { kind: submission.kind, nodes, edges: submission.edges };
}

/* 只有一个工具。叫了别的名字,当答案退给它,来回继续 */
const answerTool = (name) => ({ error: `unknown tool ${name}; the only tool is submit_step, and the node table is in the system prompt` });

const toolReply = (call, content) => ({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });

/* 一步。返回 { result(状态机认的), submission(模型交的原样), rounds, messages(整段对话), events(每个动作) }。
   没交成抛错,错误上挂着 messages 和 events,实录照样能存。 */
export async function runStep(context, { callModel, systemPrompt, maxRounds = 30, signal, onEvent = () => {} }) {
  const ref = context.step.ref;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: stepMessage(context) },
  ];
  const events = [];
  const note = (event) => { events.push(event); onEvent(event); };
  const fail = (message) => Object.assign(new Error(message), { messages, events });

  for (let round = 1; round <= maxRounds; round++) {
    let reply;
    try {
      reply = await callModel(messages, { signal, tools: executorTools });
    } catch (error) {
      /* 接口抛的错(网络、限流、key 不对)也带上对话记录:出错那一步的实录最该看,不能是空的 */
      throw Object.assign(error, { messages, events });
    }
    messages.push(reply);
    if (reply.content) note({ round, kind: "said", text: reply.content });
    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) throw fail(`执行者说话没交(第 ${round} 回合):${reply.content || "(什么都没说)"}`);

    for (const call of calls) {
      const name = call.function?.name;
      let args;
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch (error) {
        messages.push(toolReply(call, { error: `arguments is not valid JSON: ${error.message}` }));
        note({ round, kind: "bad-args", tool: name });
        continue;
      }
      if (name === "submit_step") {
        const result = toPatch(args, ref);
        const reasons = checkResult(result, ref, context.canvas);
        if (reasons.length) {
          messages.push(toolReply(call, { rejected: reasons }));
          note({ round, kind: "rejected", reasons });
          continue;
        }
        note({ round, kind: "submitted", submission: args });
        return { result, submission: args, rounds: round, messages, events };
      }
      const answer = answerTool(name);
      messages.push(toolReply(call, answer));
      note({ round, kind: "tool", tool: name, args, answer });
    }
  }
  throw fail(`执行者来回 ${maxRounds} 次没交,这一步作废`);
}

/* 插进状态机的那个函数:拿桌上的五样,还状态机认的结果。
   onEvent(事件, 上下文) 让外面看得见它一路在干什么,上下文带着是哪一步——一波里可能两步同时在做。
   save 给了目录,每一步自己的对话记录、事件、交的原样都存进去:实录是执行者自己层的东西,
   它自己存,状态机不经手;出错也存,错照样抛。 */
export function createExecutor({ callModel, systemPrompt = loadSystemPrompt(), maxRounds = 30, onEvent, save } = {}) {
  let count = 0;
  return async function executor(context, { signal, onEvent: onEventForThisCall = onEvent } = {}) {
    const ref = context.step.ref;
    const dir = save ? join(save, `${String(++count).padStart(2, "0")}-${ref}`) : null;
    const keep = (name, value) => {
      if (!dir || value === undefined) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    };
    keep("context.json", context);
    try {
      const outcome = await runStep(context, {
        callModel,
        systemPrompt,
        maxRounds,
        signal,
        onEvent: onEventForThisCall ? (event) => onEventForThisCall(event, context) : undefined,
      });
      keep("messages.json", outcome.messages);
      keep("events.json", outcome.events);
      keep("submission.json", outcome.submission);
      keep("patch.json", outcome.result);
      return outcome.result;
    } catch (error) {
      keep("messages.json", error.messages);
      keep("events.json", error.events);
      keep("error.txt", `${error.message}\n`);
      throw error;
    }
  };
}

/* 默认导出就是插口:EXECUTOR_MODULE=src/executor/executor.mjs。
   模型配置到第一次被叫到才从 .env 读,免得谁一 import 这个模块就要 key;
   EXECUTOR_SAVE=目录 时每一步的实录存进去。 */
let plugged = null;
export default async function executor(context, options) {
  plugged ??= createExecutor({ callModel: callerFromEnv(), save: process.env.EXECUTOR_SAVE });
  return plugged(context, options);
}
