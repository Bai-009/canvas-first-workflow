import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { proposePlanTool } from "./propose-plan-tool.mjs";
import { parsePartial, draftPlan } from "./partial-plan.mjs";
import { validatePlanProposal } from "./validate-plan-proposal.mjs";
import { callerFromEnv as modelCallerFromEnv } from "../model/openai-compatible.mjs";

/* 提示词两版:中文是原文,英文是按语境译的,分节一一对应。
   默认中文;PLAN_PROMPT_LANG=en 换英文版。 */
const promptFiles = {
  zh: new URL("../../prompts/plan-agent.md", import.meta.url),
  en: new URL("../../prompts/plan-agent.en.md", import.meta.url),
};

export function loadSystemPrompt(lang = "zh") {
  const file = promptFiles[lang];
  if (!file) {
    throw new Error(`没有 ${lang} 这一版提示词,可选:${Object.keys(promptFiles).join("、")}`);
  }
  return readFileSync(file, "utf8");
}

const defaultSystemPrompt = loadSystemPrompt("zh");

const MAX_GATE_RETRIES = 3;

/* 边写边看:模型一个字一个字往外吐的时候,把手上这半份交出去。
   说的话原样累加;方案是半截 JSON,退到最近能收口的地方读一遍。
   一秒最多刷十次——再密人眼也读不过来,只会闪。 */
function draftReporter(spoken, onDraft) {
  let text = "";
  let args = "";
  let last = 0;
  return (delta) => {
    if (delta.kind === "text") text += delta.text;
    else if (delta.kind === "args") args += delta.text;
    const now = Date.now();
    if (now - last < 100) return;
    last = now;
    onDraft({
      speech: [...spoken, text].filter(Boolean).join("\n\n"),
      plan: args ? draftPlan(parsePartial(args)) : null,
      /* 它在想,还是在写。想的内容不交出去:那是内心独白,而且是断的。 */
      phase: text || args ? "writing" : "thinking",
    });
  };
}

/* 一轮设计:模型先说话,可能再提交一份方案。
   方案过闸门;没过就把错误原样发回去让它重交完整一份,重试有上限。
   模型不调工具就是只说话——信息不够先澄清,这个行为本身就是合法产出。 */
export async function runPlanAgent({ callModel, messages, systemPrompt = defaultSystemPrompt, signal, onDraft }) {
  const transcript = [{ role: "system", content: systemPrompt }, ...messages];
  let lastErrors = [];
  /* 说给人听的话要攒着:闸门打回之后模型重交时通常不再说话,
     第一次说的那段不能因为重交而丢掉。 */
  const spoken = [];

  for (let attempt = 0; attempt <= MAX_GATE_RETRIES; attempt++) {
    const reply = await callModel(transcript, { signal, onDelta: onDraft && draftReporter(spoken, onDraft) });
    if (reply.content) spoken.push(reply.content);
    const speech = spoken.join("\n\n");
    const calls = reply.tool_calls ?? [];

    if (calls.length === 0) {
      return { speech, plan: null, transcript: [...transcript, reply] };
    }

    transcript.push(reply);

    const [first, ...extras] = calls;
    for (const extra of extras) {
      transcript.push({
        role: "tool",
        tool_call_id: extra.id,
        content: "一轮只处理一份方案,这份没有被读取。",
      });
    }

    let gate;
    let plan = null;
    try {
      plan = JSON.parse(first.function.arguments);
      gate = validatePlanProposal(plan);
    } catch {
      gate = { ok: false, errors: ["提交的内容不是合法的 JSON"] };
    }

    if (gate.ok) {
      transcript.push({
        role: "tool",
        tool_call_id: first.id,
        content: "方案已通过校验并收下。",
      });
      return { speech, plan, transcript };
    }

    lastErrors = gate.errors;
    transcript.push({
      role: "tool",
      tool_call_id: first.id,
      content: `方案没过校验。逐条改完后重新提交完整的一份:\n${gate.errors
        .map((error) => `- ${error}`)
        .join("\n")}`,
    });
  }

  throw new Error(
    `连续 ${MAX_GATE_RETRIES + 1} 次提交都没过校验,停止重试。最后一次的错误:\n${lastErrors.join("\n")}`
  );
}

/* 设计者的调用器:通用插座加上它唯一的工具 propose_plan。 */
export function callerFromEnv(env = process.env) {
  /* 推理是它的智力,不关。想调强度用 MODEL_REASONING(low / high / max)。 */
  return modelCallerFromEnv(env, {
    tools: [{ type: "function", function: proposePlanTool }],
    reasoning: env.MODEL_REASONING,
  });
}

async function runCli() {
  const description = process.argv.slice(2).join(" ").trim();
  if (!description) {
    console.error('用法：npm run plan -- "用一句话或几句话描述你要的数据处理"');
    process.exitCode = 2;
    return;
  }

  let callModel;
  try {
    callModel = callerFromEnv();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  const { speech, plan } = await runPlanAgent({
    callModel,
    messages: [{ role: "user", content: description }],
    systemPrompt: loadSystemPrompt(process.env.PLAN_PROMPT_LANG || "zh"),
  });

  if (speech) console.log(`${speech}\n`);
  if (plan) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log("（这一轮模型没有提交方案,只说了话。）");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
