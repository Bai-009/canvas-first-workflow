import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPlanProposal } from '../../src/plan/validate-plan-proposal.mjs';
import { isRecord } from '../../shared/json.mjs';

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
