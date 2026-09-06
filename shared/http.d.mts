import type { Annotation, Canvas, PlanProposal } from './contracts.mjs';
import type { Edit, Run, StepRecord, Turn, WorkflowState } from './workflow.mjs';
import type { PlanDraft, PlanDiff } from './plan.mjs';

export interface ChatLine { who: 'user' | 'agent'; text: string }
export interface Presentation { task?: string; speech?: string; chat?: ChatLine[] }
export interface SessionRecord {
  formatVersion: 1;
  id: string;
  title?: string;
  renamed?: boolean | undefined;
  createdAt?: string;
  updatedAt: string;
  deletedAt?: string | null | undefined;
  presentation?: Presentation;
  workflow: WorkflowState;
  notice?: string;
}
export type NewSessionRecord = Omit<SessionRecord, 'workflow'> & { workflow?: WorkflowState };
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  deletedAt: string | null;
  turn: Turn;
  nodes: number;
  storageError: string;
}
export interface SessionListing { sessions: SessionSummary[]; trash: SessionSummary[] }
export interface Snapshot extends SessionListing {
  sessionId: string;
  title: string | undefined;
  savedAt: string | null;
  storageError: string;
  notice: string;
  task: string;
  speech: string;
  chat: ChatLine[];
  wave: string[] | null;
  canvas: Canvas;
  plan: PlanProposal | null;
  revision: number;
  turn: Turn;
  hasExecutor: boolean;
  hasReviser: boolean;
  annotations: Annotation[];
  edits: Edit[];
  canvasPlanRevision: number | null;
  run: Run | null;
  sequence: number;
  feedId: string;
}
export type WorkflowEvent =
  | { type: 'snapshot'; state: Snapshot }
  | ({ type: 'sessions' } & SessionListing)
  | ({ type: 'draft'; task: string; chat: ChatLine[] } & PlanDraft)
  | { type: 'said'; text: string }
  | { type: 'thinking'; who: 'plan' | 'executor' }
  | { type: 'reset' | 'saved' | 'deleted' }
  | { type: 'plan'; task: string; chat: ChatLine[]; plan: PlanProposal | null; diff: PlanDiff | null; revision: number; canvasPlanRevision: number | null; speech: string }
  | { type: 'wave'; refs: string[] }
  | { type: 'step'; step: StepRecord; canvas: Canvas }
  | { type: 'run'; run: Run; canvas: Canvas; canvasPlanRevision: number | null }
  | { type: 'edit'; edit: Edit; edits: Edit[]; canvas: Canvas; turn: Turn; canvasPlanRevision: number | null }
  | { type: 'notes'; notes: Annotation[] }
  | { type: 'configured'; canvas: Canvas }
  | { type: 'error'; message: string; turn: Turn };
export interface SavedMetadata { sessionId: string; savedAt: string | null; storageError: string; notice: string }
export type FeedEvent = WorkflowEvent & Partial<SavedMetadata>;
export type TransportEvent = FeedEvent & { feedId: string; sequence: number };
