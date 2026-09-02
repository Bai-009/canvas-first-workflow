/* 两份方案之间按编号算差异。同一个编号出现在两边就是同一条:内容一字不差叫沿用,
   有改动叫原地改;只在新的一份里出现叫新增;只在旧的一份里出现叫消失。
   界面上的原地过渡和重画、演示数据里"答掉了哪几问"、命令行里的对照,都从这一个函数来。 */

const SECTIONS = ["understanding", "steps", "openQuestions"];

/* 键的顺序不算差异:模型两轮之间可能把 goal 和 readiness 调个位置。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function diffPlans(before, after) {
  const result = {};
  for (const section of SECTIONS) {
    const prev = new Map((before?.[section] ?? []).map((item) => [item.ref, item]));
    const next = new Map((after?.[section] ?? []).map((item) => [item.ref, item]));
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
