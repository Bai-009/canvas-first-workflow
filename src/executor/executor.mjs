/* 执行者本体:一步的来回。
   桌上的五样贴上标签发给模型,带三个工具;模型要搜就搜、要查详情就查,当场答它,答案接在对话后面;
   它一交,交的东西先过状态机那道闸门(同一道,不另造),过了就还给状态机,没过就把原因退给它再来。
   来回有上限;说话不交也算没交。 */
import { readFileSync } from "node:fs";
import { searchNodes, describeNode, catalogTools } from "./n8n-catalog.mjs";
import { submitStepTool } from "./submit-step-tool.mjs";
import { checkResult } from "../state-machine/workflow-session.mjs";
import { callerFromEnv as modelCallerFromEnv } from "../model/openai-compatible.mjs";

export const executorTools = [...catalogTools, submitStepTool];

export function loadSystemPrompt() {
  return readFileSync(new URL("../../prompts/executor.en.md", import.meta.url), "utf8");
}

export function callerFromEnv(env = process.env) {
  return modelCallerFromEnv(env, { tools: executorTools });
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/* 五样贴标签。画布上的节点在状态机里叫 id,在模型那边叫 name:发出去时换叫法,交回来再换回去。 */
export function stepMessage(context) {
  const { plan, step, canvas, openQuestions, instructions } = context;
  const nodes = canvas.nodes.map(({ id, ...rest }) => ({ name: id, ...rest }));
  const block = (tag, value) => `<${tag}>\n${JSON.stringify(value, null, 2)}\n</${tag}>`;
  return [
    block("plan", plan),
    block("step", step),
    block("canvas", { nodes, edges: canvas.edges }),
    block("open_questions", openQuestions),
    block("annotations", instructions),
  ].join("\n\n");
}

/* 模型交的 → 状态机认的:name 变 id,step 由这里补,线上的出口留着。形状不对的原样递过去让闸门说话。 */
export function toPatch(submission, ref) {
  if (!isObject(submission)) return submission;
  if (submission.kind === "covered") return { kind: "covered" };
  const nodes = Array.isArray(submission.nodes)
    ? submission.nodes.map((node) =>
        isObject(node) ? { id: node.name, step: ref, type: node.type, params: node.params, blanks: node.blanks } : node
      )
    : submission.nodes;
  const edges = Array.isArray(submission.edges)
    ? submission.edges.map((edge) =>
        isObject(edge) && edge.output !== undefined
          ? { from: edge.from, to: edge.to, output: edge.output }
          : isObject(edge) ? { from: edge.from, to: edge.to } : edge
      )
    : submission.edges;
  return { kind: submission.kind, nodes, edges };
}

function answerTool(name, args) {
  try {
    if (name === "search_nodes") return searchNodes(String(args.query ?? ""));
    if (name === "describe_node") return describeNode(args.type, { resource: args.resource, operation: args.operation });
    return { error: `unknown tool ${name}` };
  } catch (error) {
    return { error: error.message };
  }
}

const toolReply = (call, content) => ({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });

/* 一步。返回 { result(状态机认的), submission(模型交的原样), rounds, messages(整段对话), events(每个动作) }。
   没交成抛错,错误上挂着 messages 和 events,实录照样能存。 */
export async function runStep(context, { callModel, systemPrompt, maxRounds = 12, signal, onEvent = () => {} }) {
  const ref = context.step.ref;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: stepMessage(context) },
  ];
  const events = [];
  const note = (event) => { events.push(event); onEvent(event); };
  const fail = (message) => Object.assign(new Error(message), { messages, events });

  for (let round = 1; round <= maxRounds; round++) {
    const reply = await callModel(messages, { signal, tools: executorTools });
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
      const answer = answerTool(name, args);
      messages.push(toolReply(call, answer));
      note({ round, kind: "tool", tool: name, args, answer });
    }
  }
  throw fail(`执行者来回 ${maxRounds} 次没交,这一步作废`);
}

/* 插进状态机的那个函数:拿桌上的五样,还状态机认的结果。 */
export function createExecutor({ callModel, systemPrompt = loadSystemPrompt(), maxRounds = 12, onEvent } = {}) {
  return async function executor(context, { signal } = {}) {
    const { result } = await runStep(context, { callModel, systemPrompt, maxRounds, signal, onEvent });
    return result;
  };
}
