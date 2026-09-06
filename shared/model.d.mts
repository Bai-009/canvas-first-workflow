export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface AssistantMessage {
  role: 'assistant';
  content?: string | null;
  tool_calls?: ToolCall[] | null;
}
export type Message = AssistantMessage
  | { role: 'system' | 'user'; content: string }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ModelTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export type ModelDelta = { kind: 'text' | 'reason'; text: string }
  | { kind: 'args'; index: number; text: string };
export interface CallOptions {
  signal?: AbortSignal | undefined;
  tools?: ModelTool[] | undefined;
  onDelta?: ((delta: ModelDelta) => void) | undefined;
}
export type ModelCaller = (messages: Message[], options?: CallOptions) => Promise<AssistantMessage>;
export interface ModelSettings {
  tools?: ModelTool[] | undefined;
  reasoning?: string | undefined;
}
