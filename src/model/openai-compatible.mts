import type { AssistantMessage, ToolCall, ModelCaller, ModelSettings, ModelDelta } from "../../shared/model.mjs";
import { assistantFromResponse, deltaFromResponse } from "./model-response.mjs";

/* 通用插座:任何 OpenAI 兼容接口都能接(DeepSeek、Kimi、Ollama、vLLM……)。
   不引厂商 SDK,换模型只换地址、key、模型名。设计者和执行者共用这一个,各自带自己的工具进来。 */
export function openAiCompatibleCaller({ baseUrl, apiKey, model, tools = [], reasoning }: ModelSettings & { baseUrl: string; apiKey: string; model: string }): ModelCaller {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async function callModel(messages, { signal, tools: toolsForThisCall = tools, onDelta } = {}) {
    const body: Record<string, unknown> = { model, messages };
    /* 会推理的模型先想很久再动笔。想的那几十秒里外面看不到任何东西,
       所以要边写边看的地方把它关掉:关掉之后第一个字零点几秒就到。 */
    if (reasoning) body.reasoning_effort = reasoning;
    if (toolsForThisCall.length) {
      body.tools = toolsForThisCall;
      body.tool_choice = "auto";
    }
    /* 有人要边写边看就走流式。收回来的形状跟一次性返回的那份一模一样,
       上面那几层不用知道这一层是怎么拿到的。 */
    if (onDelta) body.stream = true;
    const response = await fetch(endpoint, {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`模型接口返回 ${response.status}：${await response.text()}`);
    }
    if (!onDelta) {
      const reply: unknown = await response.json();
      return assistantFromResponse(reply);
    }
    return readStream(response, onDelta);
  };
}

/* 流式:一行行读回来,拼成跟一次性返回一模一样的一条消息;
   拼的同时把每一小块交给 onDelta——正文是一块块的字,工具参数是一块块的 JSON 文本。 */
async function readStream(response: Response, onDelta: (delta: ModelDelta) => void): Promise<AssistantMessage> {
  if (!response.body) throw new Error("模型接口返回了空的响应流");
  const message: AssistantMessage = { role: "assistant", content: "" };
  const calls: ToolCall[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let piece: unknown;
      try { piece = JSON.parse(payload); } catch { continue; }
      const delta = deltaFromResponse(piece);
      if (!delta) continue;
      if (delta.content) {
        message.content = (message.content ?? "") + delta.content;
        onDelta({ kind: "text", text: delta.content });
      }
      /* 会推理的模型先想很久再动笔。想的过程它一直在往外吐,不接住,
         那段时间在用户那边就是一片空白。想的内容不进对话记录,只用来报进度。 */
      if (delta.reasoning_content) onDelta({ kind: "reason", text: delta.reasoning_content });
      for (const call of delta.tool_calls ?? []) {
        const i = call.index ?? 0;
        const assembled = calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (call.id) assembled.id = call.id;
        if (call.function?.name) assembled.function.name = call.function.name;
        const args = call.function?.arguments;
        if (args) {
          assembled.function.arguments += args;
          onDelta({ kind: "args", index: i, text: args });
        }
      }
    }
  }
  if (calls.length) message.tool_calls = calls.filter(Boolean);
  if (!message.content) delete message.content;
  return message;
}

/* 从 .env 组装调用器;三项缺一个就报错,不猜。 */
export function callerFromEnv(env: NodeJS.ProcessEnv = process.env, { tools = [], reasoning }: ModelSettings = {}): ModelCaller {
  const { MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME } = env;
  if (!MODEL_BASE_URL || !MODEL_API_KEY || !MODEL_NAME) {
    throw new Error(
      "缺少模型配置。把 .env.example 抄成 .env,填上 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME。"
    );
  }
  return openAiCompatibleCaller({ baseUrl: MODEL_BASE_URL, apiKey: MODEL_API_KEY, model: MODEL_NAME, tools, reasoning });
}
