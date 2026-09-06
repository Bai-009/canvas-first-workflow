/* 两份方案之间按编号算差异。同一个编号出现在两边就是同一条:内容一字不差叫沿用,
   有改动叫原地改;只在新的一份里出现叫新增;只在旧的一份里出现叫消失。
   界面上的原地过渡和重画、演示数据里"答掉了哪几问"、命令行里的对照,都从这一个函数来。 */

import type { PlanProposal } from '../../shared/contracts.mjs';
const SECTIONS = ["understanding", "steps", "openQuestions"] as const;
import type { PlanDiff, SectionDiff } from "../../shared/plan.mjs";
export type { PlanDiff, SectionDiff } from "../../shared/plan.mjs";

/* 键的顺序不算差异:模型两轮之间可能把 goal 和 readiness 调个位置。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function diffPlans(before: PlanProposal | null | undefined, after: PlanProposal | null | undefined): PlanDiff {
  const empty = (): SectionDiff => ({ kept: [], changed: [], added: [], removed: [] });
  const result: PlanDiff = { understanding: empty(), steps: empty(), openQuestions: empty() };
  for (const section of SECTIONS) {
    const prev = new Map<string, unknown>((before?.[section] ?? []).map((item) => [item.ref, item]));
    const next = new Map<string, unknown>((after?.[section] ?? []).map((item) => [item.ref, item]));
    const kept = [];
    const changed = [];
    const added = [];
    const removed = [];
    for (const [ref, item] of next) {
      if (!prev.has(ref)) added.push(ref);
      else if (same(prev.get(ref), item)) kept.push(ref);
      else changed.push(ref);
    }
    for (const ref of prev.keys()) if (!next.has(ref)) removed.push(ref);
    result[section] = { kept, changed, added, removed };
  }
  return result;
}
