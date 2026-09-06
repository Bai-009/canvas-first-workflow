import { isRecord } from '../../shared/json.mjs';
import type { AssistantMessage, Message, ToolCall } from '../../shared/model.mjs';

function isToolCall(value: unknown): value is ToolCall {
  return isRecord(value) && typeof value.id === 'string' && value.type === 'function'
    && isRecord(value.function) && typeof value.function.name === 'string'
    && typeof value.function.arguments === 'string';
}

function isAssistant(value: unknown): value is AssistantMessage {
  return isRecord(value) && value.role === 'assistant'
    && (value.content == null || typeof value.content === 'string')
    && (value.tool_calls == null || (Array.isArray(value.tool_calls) && value.tool_calls.every(isToolCall)));
}

export function isMessage(value: unknown): value is Message {
  if (isAssistant(value)) return true;
  if (!isRecord(value) || typeof value.content !== 'string') return false;
  return value.role === 'user' || value.role === 'system'
    || (value.role === 'tool' && typeof value.tool_call_id === 'string');
}

export function assistantFromResponse(value: unknown): AssistantMessage {
  const choice = isRecord(value) && Array.isArray(value.choices) ? value.choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  return normalizeAssistant(message);
}

// 外部兼容格式先适配为内部消息；存档 isMessage 仍检查已经规范化的格式。
export function normalizeAssistant(message: unknown): AssistantMessage {
  const invalid = () => new Error('模型接口没有返回有效的 assistant 消息');
  if (!isRecord(message) || message.role !== 'assistant'
    || (message.content != null && typeof message.content !== 'string')) throw invalid();
  if (message.tool_calls == null) {
    if (!isAssistant(message)) throw invalid();
    return message;
  }
  if (!Array.isArray(message.tool_calls)) throw invalid();
  const tool_calls = message.tool_calls.map((call: unknown): ToolCall => {
    if (!isRecord(call) || typeof call.id !== 'string' || !call.id.trim()
      || (call.type != null && call.type !== 'function') || !isRecord(call.function)
      || typeof call.function.name !== 'string' || !call.function.name.trim()) throw invalid();
    const args = call.function.arguments;
    // 不解析字符串：坏 JSON 应进入工具纠错循环，不在传输层终止整轮。
    // 没带参数按空参数交，跟流式一条路：空参数机器转得动，由闸门退回重试。
    if (args != null && typeof args !== 'string' && !isRecord(args)) throw invalid();
    return { ...call, id: call.id, type: 'function', function: { ...call.function, name: call.function.name,
      arguments: args == null ? '' : typeof args === 'string' ? args : JSON.stringify(args) } };
  });
  const normalized = { ...message, tool_calls };
  if (!isAssistant(normalized)) throw invalid();
  return normalized;
}

interface StreamCall {
  index?: number | null;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | Record<string, unknown> | null } | null;
}
interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: StreamCall[] | null;
}
function isStreamCall(value: unknown): value is StreamCall {
  if (!isRecord(value)) return false;
  if (value.type != null && value.type !== 'function') return false;
  if (value.index != null && (typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0)) return false;
  if (value.id != null && typeof value.id !== 'string') return false;
  return value.function == null || (isRecord(value.function)
    && (value.function.name == null || typeof value.function.name === 'string')
    && (value.function.arguments == null || typeof value.function.arguments === 'string' || isRecord(value.function.arguments)));
}
function isDelta(value: unknown): value is StreamDelta {
  return isRecord(value)
    && (value.content == null || typeof value.content === 'string')
    && (value.reasoning_content == null || typeof value.reasoning_content === 'string')
    && (value.tool_calls == null || (Array.isArray(value.tool_calls) && value.tool_calls.every(isStreamCall)));
}
export function deltaFromResponse(value: unknown): StreamDelta | null {
  const choice = isRecord(value) && Array.isArray(value.choices) ? value.choices[0] : undefined;
  const delta = isRecord(choice) ? choice.delta : undefined;
  if (!delta) return null;
  if (!isDelta(delta)) throw new Error('模型接口返回了无效的流式消息');
  return delta;
}
