import type { Canvas, CanvasNode, Edge, Annotation } from '../../shared/contracts.mjs';
import type { WorkflowState, Run, Edit, StepRecord } from '../../shared/workflow.mjs';
import type { SessionRecord, Presentation, ChatLine } from '../../shared/http.mjs';
import { isRecord } from '../../shared/json.mjs';
import { isMessage } from '../model/model-response.mjs';
import { isPlanProposal } from '../plan/validate-plan-proposal.mjs';

const string = (value: unknown): value is string => typeof value === 'string';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const optional = <T,>(value: unknown, check: (value: unknown) => value is T): value is T | undefined => value === undefined || check(value);
const array = <T,>(value: unknown, check: (value: unknown) => value is T): value is T[] => Array.isArray(value) && value.every(check);
const strings = (value: unknown): value is string[] => array(value, string);
const oneOf = (value: unknown, values: readonly string[]): boolean => values.some((item) => item === value);

function isNode(value: unknown): value is CanvasNode {
  return isRecord(value) && string(value.name) && string(value.type) && string(value.step)
    && isRecord(value.params) && strings(value.blanks);
}
function isEdge(value: unknown): value is Edge {
  return isRecord(value) && string(value.from) && string(value.to) && optional(value.output, string);
}
export function isCanvas(value: unknown): value is Canvas {
  return isRecord(value) && integer(value.version) && array(value.nodes, isNode) && array(value.edges, isEdge);
}
function isStepRecord(value: unknown): value is StepRecord {
  return isRecord(value) && string(value.ref) && integer(value.canvasVersion)
    && oneOf(value.outcome, ['done', 'covered', 'stopped', 'failed', 'rejected'])
    && optional(value.nodes, strings) && optional(value.reasons, strings) && optional(value.error, string);
}
function isRun(value: unknown): value is Run {
  return isRecord(value) && integer(value.revision) && array(value.steps, isStepRecord) && strings(value.problems)
    && (value.endedBy === null || oneOf(value.endedBy, ['finished', 'stopped', 'error', 'rejected', 'interrupted']));
}
function isTarget(value: unknown): value is Edit['target'] {
  return isRecord(value) && string(value.node) && string(value.step);
}
function isReview(value: unknown): value is Edit['review'][number] {
  return isRecord(value) && string(value.step) && string(value.summary);
}
function isEdit(value: unknown): value is Edit {
  return isRecord(value) && string(value.id) && isTarget(value.target) && string(value.text) && string(value.summary)
    && oneOf(value.status, ['processing', 'checking', 'stopped', 'failed', 'applied', 'unchanged', 'needs_plan'])
    && strings(value.changes) && array(value.review, isReview) && integer(value.baseVersion)
    && integer(value.canvasVersion) && integer(value.planRevision) && string(value.createdAt)
    && optional(value.completedAt, string) && (value.durationMs === undefined || typeof value.durationMs === 'number')
    && optional(value.error, string) && optional(value.reasons, strings);
}
function isAnnotation(value: unknown): value is Annotation {
  return isRecord(value) && string(value.step) && string(value.text);
}
export function isWorkflowState(value: unknown): value is WorkflowState {
  return isRecord(value) && value.formatVersion === 1 && isRecord(value.plan)
    && array(value.plan.transcript, isMessage) && array(value.plan.versions, isPlanProposal)
    && isCanvas(value.canvas) && array(value.annotations, isAnnotation) && array(value.runs, isRun) && array(value.edits, isEdit)
    && (value.canvasPlanRevision === null || integer(value.canvasPlanRevision))
    && (value.activeRun === null || isRun(value.activeRun)) && oneOf(value.turn, ['user', 'plan', 'executor', 'revision']);
}
function isChatLine(value: unknown): value is ChatLine {
  return isRecord(value) && (value.who === 'user' || value.who === 'agent') && string(value.text);
}
function isPresentation(value: unknown): value is Presentation {
  return isRecord(value) && optional(value.task, string) && optional(value.speech, string)
    && (value.chat === undefined || array(value.chat, isChatLine));
}

// 只检查存档可被安全读取的形状。部分构建、留空参数和历史元数据原样保留；不要求画布已经完成。
export function isSessionRecord(value: unknown): value is SessionRecord {
  return isRecord(value) && value.formatVersion === 1 && string(value.id) && /^[a-zA-Z0-9-]{1,80}$/.test(value.id)
    && string(value.updatedAt) && optional(value.createdAt, string) && optional(value.title, string)
    && (value.renamed === undefined || typeof value.renamed === 'boolean')
    && (value.deletedAt == null || string(value.deletedAt)) && optional(value.notice, string)
    && (value.presentation === undefined || isPresentation(value.presentation)) && isWorkflowState(value.workflow);
}
