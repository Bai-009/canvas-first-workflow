import type { Annotation, Canvas, PlanProposal, Requirement, RevisionResult, StepContext, StepResult } from './contracts.mjs';
import type { Message, ModelCaller } from './model.mjs';

export type Turn = 'user' | 'plan' | 'executor' | 'revision';
export interface StepRecord {
  ref: string;
  outcome: 'done' | 'covered' | 'stopped' | 'failed' | 'rejected';
  canvasVersion: number;
  nodes?: string[];
  reasons?: string[];
  error?: string;
}
export interface Run {
  revision: number;
  steps: StepRecord[];
  endedBy: 'finished' | 'stopped' | 'error' | 'rejected' | 'interrupted' | null;
  problems: string[];
}
export interface Edit {
  id: string;
  target: { node: string; step: string };
  text: string;
  status: 'processing' | 'checking' | 'stopped' | 'failed' | 'applied' | 'unchanged' | 'needs_plan';
  summary: string;
  changes: string[];
  review: RevisionResult['review'];
  baseVersion: number;
  canvasVersion: number;
  planRevision: number;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  reasons?: string[];
}
export interface WorkflowState {
  formatVersion: 1;
  plan: { transcript: Message[]; versions: PlanProposal[] };
  canvas: Canvas;
  annotations: Annotation[];
  runs: Run[];
  edits: Edit[];
  canvasPlanRevision: number | null;
  activeRun: Run | null;
  turn: Turn;
}
export interface RevisionContext {
  plan: PlanProposal;
  canvas: Canvas;
  target: { node: string; step: string };
  instruction: { id: string; text: string };
  requirements?: Requirement[];
  annotations?: Annotation[];
  // 调用层保留完整实录，不解释历史记录中的业务字段。
  history?: { runs: unknown[]; edits: unknown[] };
}
export type AgentEvent = { round: number } & (
  | { kind: 'said'; text: string }
  | { kind: 'no-call'; wrote: boolean }
  | { kind: 'bad-args'; tool: string; reason?: string }
  | { kind: 'rejected'; reasons: string[] }
  | { kind: 'submitted'; submission: unknown }
  | { kind: 'tool'; tool: string; args?: unknown; answer: { error: string } }
);
export interface AgentTiming {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'accepted' | 'stopped' | 'failed';
  rounds: number;
}
export interface AgentOptions {
  signal?: AbortSignal | undefined;
}
export interface ExecutorOptions extends AgentOptions {
  onEvent?: ((event: AgentEvent, context: StepContext) => void) | undefined;
}
// 可替换的 Agent 是外部边界：结果为 unknown，宿主仍必须通过门禁。
export type Executor = (context: StepContext, options?: ExecutorOptions) => Promise<unknown>;
export type Reviser = (context: RevisionContext, options?: AgentOptions) => Promise<unknown>;
export interface WorkflowOptions {
  callModel: ModelCaller;
  executor?: Executor | null | undefined;
  reviser?: Reviser | null | undefined;
  systemPrompt?: string | undefined;
  savedState?: WorkflowState | undefined;
}
export interface StepOutcome {
  result: StepResult;
  submission: unknown;
  rounds: number;
  messages: Message[];
  events: AgentEvent[];
}
