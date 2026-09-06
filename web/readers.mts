import type { Canvas, PlanProposal, NodeDefinition } from '../shared/contracts.mjs';
import type { ChatLine, SessionListing, SessionSummary, Snapshot, TransportEvent } from '../shared/http.mjs';
import type { Turn } from '../shared/workflow.mjs';
import type { PlanDraft } from '../src/plan/plan-agent.mjs';
import type { PlanDiff } from '../src/plan/plan-diff.mjs';
import { isRecord } from '../shared/json.mjs';
import { string, integer, optional, array, strings, oneOf, isCanvas, isRun, isEdit, isAnnotation, isStepRecord } from '../shared/workflow-shape.mjs';
import { KINDS } from './flow.mjs';

// 浏览器只确认收到的结构可安全读取；业务含义和全图裁决仍由服务端负责。
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const nullable = <T,>(v: unknown, check: (v: unknown) => v is T): v is T | null => v === null || check(v);
const turn = (v: unknown): v is Turn => oneOf(v, ['user', 'plan', 'executor', 'revision']);
const isChat = (v: unknown): v is ChatLine => isRecord(v) && oneOf(v.who, ['user', 'agent']) && string(v.text);
const hasText = <K extends string>(v: unknown, keys: K[]): v is Record<K, string> & Record<string, unknown> => isRecord(v) && keys.every(k => string(v[k]));
function isPlan(v: unknown): v is PlanProposal {
  return isRecord(v) && oneOf(v.readiness, ['ready', 'partial']) && string(v.goal)
    && array(v.understanding, (r): r is PlanProposal['understanding'][number] => hasText(r, ['ref', 'quote', 'reading']))
    && array(v.steps, (r): r is PlanProposal['steps'][number] => hasText(r, ['ref', 'title', 'intent', 'input', 'output']) && strings(r.dependsOn))
    && array(v.openQuestions, (r): r is PlanProposal['openQuestions'][number] => hasText(r, ['ref', 'question', 'reason']) && strings(r.affects) && optional(r.options, strings));
}
function isDraft(v: unknown): v is PlanDraft {
  return isRecord(v) && string(v.speech) && oneOf(v.phase, ['writing', 'thinking']) && (v.plan === null || (
    isRecord(v.plan) && string(v.plan.goal) && v.plan.readiness != null
    && array(v.plan.understanding, (r): r is NonNullable<PlanDraft['plan']>['understanding'][number] => hasText(r, ['ref', 'quote', 'reading']))
    && array(v.plan.steps, (r): r is NonNullable<PlanDraft['plan']>['steps'][number] => hasText(r, ['ref', 'title']))
    && array(v.plan.openQuestions, (r): r is NonNullable<PlanDraft['plan']>['openQuestions'][number] => hasText(r, ['ref', 'question']))));
}
function isDiff(v: unknown): v is PlanDiff {
  return isRecord(v) && ['understanding', 'steps', 'openQuestions'].every(key => {
    const section = v[key];
    return isRecord(section) && strings(section.kept) && strings(section.changed) && strings(section.added) && strings(section.removed);
  });
}
function isSummary(v: unknown): v is SessionSummary {
  return hasText(v, ['id', 'title', 'updatedAt', 'storageError']) && nullable(v.deletedAt, string) && turn(v.turn) && integer(v.nodes);
}
export type Listing = SessionListing & { warnings?: string[] };
function isListing(v: unknown): v is Listing {
  return isRecord(v) && array(v.sessions, isSummary) && array(v.trash, isSummary) && optional(v.warnings, strings);
}
function isSnapshot(v: unknown): v is Snapshot {
  return isListing(v) && isRecord(v) && hasText(v, ['sessionId', 'storageError', 'notice', 'task', 'speech', 'feedId'])
    && optional(v.title, string) && nullable(v.savedAt, string) && array(v.chat, isChat) && nullable(v.wave, strings)
    && isCanvas(v.canvas) && nullable(v.plan, isPlan) && integer(v.revision) && turn(v.turn)
    && bool(v.hasExecutor) && bool(v.hasReviser) && array(v.annotations, isAnnotation) && array(v.edits, isEdit)
    && nullable(v.canvasPlanRevision, integer) && nullable(v.run, isRun) && integer(v.sequence);
}
function isDefinition(v: unknown): v is NodeDefinition {
  const kind = (v: unknown) => v === null || KINDS.some(k => k === v);
  return hasText(v, ['type', 'kind', 'summary', 'color'])
    && array(v.slots, (s): s is NodeDefinition['slots'][number] => hasText(s, ['key', 'label'])
      && oneOf(s.kind, ['source', 'credential', 'pick', 'number', 'body', 'conditions', 'text', 'upload'])
      && (s.options === undefined || strings(s.options) && s.options.length > 0)
      && optional(s.empty, string) && optional(s.required, bool))
    && (v.input === undefined || isRecord(v.input) && kind(v.input.needs))
    && isRecord(v.output) && string(v.output.per) && (kind(v.output.adds) || string(v.output.adds) && v.output.adds.startsWith('slot:'))
    && (v.ports === undefined || strings(v.ports) && v.ports.length >= 2);
}
function isEvent(v: unknown): v is TransportEvent {
  if (!isRecord(v) || !string(v.feedId) || !integer(v.sequence) || !optional(v.sessionId, string)
    || !optional(v.savedAt, (x): x is string | null => nullable(x, string)) || !optional(v.storageError, string) || !optional(v.notice, string)) return false;
  switch (v.type) {
    case 'snapshot': return isSnapshot(v.state);
    case 'sessions': return isListing(v);
    case 'draft': return string(v.task) && array(v.chat, isChat) && isDraft(v);
    case 'said': return string(v.text);
    case 'thinking': return oneOf(v.who, ['plan', 'executor']);
    case 'reset': case 'saved': case 'deleted': return true;
    case 'plan': return hasText(v, ['task', 'speech']) && array(v.chat, isChat) && nullable(v.plan, isPlan) && nullable(v.diff, isDiff)
      && integer(v.revision) && nullable(v.canvasPlanRevision, integer);
    case 'wave': return strings(v.refs);
    case 'step': return isStepRecord(v.step) && isCanvas(v.canvas);
    case 'run': return isRun(v.run) && isCanvas(v.canvas) && nullable(v.canvasPlanRevision, integer);
    case 'edit': return isEdit(v.edit) && array(v.edits, isEdit) && isCanvas(v.canvas) && turn(v.turn) && nullable(v.canvasPlanRevision, integer);
    case 'notes': return array(v.notes, isAnnotation);
    case 'configured': return isCanvas(v.canvas);
    case 'error': return string(v.message) && turn(v.turn);
    default: return false;
  }
}
function read<T>(value: unknown, check: (value: unknown) => value is T, label: string): T {
  if (!check(value)) throw new Error(`${label}格式不正确，请刷新后重试。`);
  return value;
}
export const readSnapshot = (value: unknown) => read(value, isSnapshot, '工作流');
export const readListing = (value: unknown) => read(value, isListing, '会话列表');
export const readCanvas = (value: unknown): Canvas => read(value, isCanvas, '画布');
export const readEvent = (value: unknown) => read(value, isEvent, '工作流事件');
export const readNodeTable = (value: unknown) => read(value, (v): v is NodeDefinition[] => array(v, isDefinition), '节点定义');
