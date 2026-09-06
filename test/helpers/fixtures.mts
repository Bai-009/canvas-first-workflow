import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPlanProposal } from '../../src/plan/validate-plan-proposal.mjs';
import { isRecord } from '../../shared/json.mjs';
import type { CanvasNode, RevisionNode, PlanProposal, PlanStep } from '../../shared/contracts.mjs';

export function present<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null, '测试预期的条目必须存在');
  return value;
}
export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), '测试输入必须是对象');
  return value;
}
export function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'));
}
export function readPlan(url: URL) {
  const value = readJson(url);
  assert.ok(isPlanProposal(value), '测试使用的有效方案必须通过原有契约和语义检查');
  return value;
}

export function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), '测试输入必须是数组');
  return value;
}
export function text(value: unknown): string {
  assert.ok(typeof value === 'string', '测试输入必须是字符串');
  return value;
}
export function jsonObject(value: unknown): Record<string, unknown> {
  return record(JSON.parse(text(value)));
}
export function revisionNode(value: CanvasNode | undefined): RevisionNode {
  const node = present(value);
  return { ...node, note: text(node.note) };
}
export function deferred<T>() {
  // Promise 构造函数同步运行，返回对象前两个回调均已赋值。
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function planWithSteps(steps: (Pick<PlanStep, 'ref' | 'dependsOn'> & Partial<PlanStep>)[]): PlanProposal {
  return { readiness: 'ready', goal: '测试工作流', understanding: [], openQuestions: [],
    steps: steps.map(step => ({ title: step.ref, intent: '测试步骤', input: '输入', output: '输出', ...step })) };
}
