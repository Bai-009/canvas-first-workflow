/* 通用插座:任何 OpenAI 兼容接口都能接(DeepSeek、Kimi、Ollama、vLLM……)。
   不引厂商 SDK,换模型只换地址、key、模型名。设计者和执行者共用这一个,各自带自己的工具进来。 */
export function openAiCompatibleCaller({ baseUrl, apiKey, model, tools = [] }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async function callModel(messages, { signal, tools: toolsForThisCall = tools } = {}) {
    const body = { model, messages };
    if (toolsForThisCall.length) {
      body.tools = toolsForThisCall;
      body.tool_choice = "auto";
    }
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`模型接口返回 ${response.status}：${await response.text()}`);
    }
    const reply = await response.json();
    return reply.choices[0].message;
  };
}

/* 从 .env 组装调用器;三项缺一个就报错,不猜。 */
export function callerFromEnv(env = process.env, { tools = [] } = {}) {
  const { MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME } = env;
  if (!MODEL_BASE_URL || !MODEL_API_KEY || !MODEL_NAME) {
    throw new Error(
      "缺少模型配置。把 .env.example 抄成 .env,填上 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME。"
    );
  }
  return openAiCompatibleCaller({ baseUrl: MODEL_BASE_URL, apiKey: MODEL_API_KEY, model: MODEL_NAME, tools });
}
