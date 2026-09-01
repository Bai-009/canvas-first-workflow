import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { proposePlanTool } from "./propose-plan-tool.mjs";
import { validatePlanProposal } from "./validate-plan-proposal.mjs";

const systemPrompt = readFileSync(
  new URL("../prompts/plan-agent.md", import.meta.url),
  "utf8"
);

const MAX_GATE_RETRIES = 3;

/* 通用插座:任何 OpenAI 兼容接口都能接(DeepSeek、Kimi、Ollama、vLLM……)。
   不引厂商 SDK,换模型只换地址、key、模型名。 */
export function openAiCompatibleCaller({ baseUrl, apiKey, model }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async function callModel(messages) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: [{ type: "function", function: proposePlanTool }],
        tool_choice: "auto",
      }),
    });
    if (!response.ok) {
      throw new Error(`模型接口返回 ${response.status}：${await response.text()}`);
    }
    const body = await response.json();
    return body.choices[0].message;
  };
}

/* 一轮设计:模型先说话,可能再提交一份方案。
   方案过闸门;没过就把错误原样发回去让它重交完整一份,重试有上限。
   模型不调工具就是只说话——信息不够先澄清,这个行为本身就是合法产出。 */
export async function runPlanAgent({ callModel, messages }) {
  const transcript = [{ role: "system", content: systemPrompt }, ...messages];
  let lastErrors = [];

  for (let attempt = 0; attempt <= MAX_GATE_RETRIES; attempt++) {
    const reply = await callModel(transcript);
    const speech = reply.content ?? "";
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

async function runCli() {
  const description = process.argv.slice(2).join(" ").trim();
  if (!description) {
    console.error('用法：npm run plan -- "用一句话或几句话描述你要的数据处理"');
    process.exitCode = 2;
    return;
  }

  const { MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME } = process.env;
  if (!MODEL_BASE_URL || !MODEL_API_KEY || !MODEL_NAME) {
    console.error(
      "缺少模型配置。把 .env.example 抄成 .env,填上 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME。"
    );
    process.exitCode = 2;
    return;
  }

  const callModel = openAiCompatibleCaller({
    baseUrl: MODEL_BASE_URL,
    apiKey: MODEL_API_KEY,
    model: MODEL_NAME,
  });

  const { speech, plan } = await runPlanAgent({
    callModel,
    messages: [{ role: "user", content: description }],
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
