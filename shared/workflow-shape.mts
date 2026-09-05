import type { Canvas, CanvasNode, Edge, Annotation } from './contracts.mjs';
import type { Run, Edit, StepRecord } from './workflow.mjs';
import { isRecord } from './json.mjs';

// 结构读取检查不做业务裁决；服务端的计划与修订门禁仍独立执行。
export const string = (value: unknown): value is string => typeof value === 'string';
export const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
export const optional = <T,>(value: unknown, check: (value: unknown) => value is T): value is T | undefined => value === undefined || check(value);
export const array = <T,>(value: unknown, check: (value: unknown) => value is T): value is T[] => Array.isArray(value) && value.every(check);
export const strings = (value: unknown): value is string[] => array(value, string);
export const oneOf = (value: unknown, values: readonly string[]): boolean => values.some((item) => item === value);

export function isNode(value: unknown): value is CanvasNode {
  return isRecord(value) && string(value.name) && string(value.type) && string(value.step)
    && isRecord(value.params) && strings(value.blanks);
}
export function isEdge(value: unknown): value is Edge {
  return isRecord(value) && string(value.from) && string(value.to) && optional(value.output, string);
}
export function isCanvas(value: unknown): value is Canvas {
  return isRecord(value) && integer(value.version) && array(value.nodes, isNode) && array(value.edges, isEdge);
}
export function isStepRecord(value: unknown): value is StepRecord {
  return isRecord(value) && string(value.ref) && integer(value.canvasVersion)
    && oneOf(value.outcome, ['done', 'covered', 'stopped', 'failed', 'rejected'])
    && optional(value.nodes, strings) && optional(value.reasons, strings) && optional(value.error, string);
}
export function isRun(value: unknown): value is Run {
  return isRecord(value) && integer(value.revision) && array(value.steps, isStepRecord) && strings(value.problems)
    && (value.endedBy === null || oneOf(value.endedBy, ['finished', 'stopped', 'error', 'rejected', 'interrupted']));
}
export function isTarget(value: unknown): value is Edit['target'] {
  return isRecord(value) && string(value.node) && string(value.step);
}
export function isReview(value: unknown): value is Edit['review'][number] {
  return isRecord(value) && string(value.step) && string(value.summary);
}
export function isEdit(value: unknown): value is Edit {
  return isRecord(value) && string(value.id) && isTarget(value.target) && string(value.text) && string(value.summary)
    && oneOf(value.status, ['processing', 'checking', 'stopped', 'failed', 'applied', 'unchanged', 'needs_plan'])
    && strings(value.changes) && array(value.review, isReview) && integer(value.baseVersion)
    && integer(value.canvasVersion) && integer(value.planRevision) && string(value.createdAt)
    && optional(value.completedAt, string) && (value.durationMs === undefined || typeof value.durationMs === 'number')
    && optional(value.error, string) && optional(value.reasons, strings);
}
export function isAnnotation(value: unknown): value is Annotation {
  return isRecord(value) && string(value.step) && string(value.text);
}
