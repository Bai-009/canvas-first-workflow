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
  if (!isAssistant(message)) throw new Error('模型接口没有返回有效的 assistant 消息');
  return message;
}

interface StreamCall {
  index?: number | null;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
}
interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: StreamCall[] | null;
}
function isStreamCall(value: unknown): value is StreamCall {
  if (!isRecord(value)) return false;
  if (value.index != null && (typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0)) return false;
  if (value.id != null && typeof value.id !== 'string') return false;
  return value.function == null || (isRecord(value.function)
    && (value.function.name == null || typeof value.function.name === 'string')
    && (value.function.arguments == null || typeof value.function.arguments === 'string'));
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
