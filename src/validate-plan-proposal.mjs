import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TOP_LEVEL_KEYS = new Set([
  "readiness",
  "goal",
  "understanding",
  "steps",
  "openQuestions"
]);
const READING_KEYS = new Set(["ref", "quote", "reading"]);
const STEP_KEYS = new Set(["ref", "title", "intent", "input", "output", "dependsOn"]);
const QUESTION_KEYS = new Set(["ref", "question", "reason", "affects"]);
const READINESS_VALUES = new Set(["ready", "partial", "blocked"]);
const REF_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function checkAllowedKeys(record, allowed, path, errors) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} 不是允许的字段`);
  }
}

function checkStringArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return false;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (!nonEmptyString(item)) errors.push(`${path}[${index}] 必须是非空字符串`);
    if (seen.has(item)) errors.push(`${path} 不能包含重复值 ${String(item)}`);
    seen.add(item);
  });
  return true;
}

function findCycle(stepsByRef) {
  const visiting = new Set();
  const visited = new Set();

  function visit(ref, trail) {
    if (visiting.has(ref)) return [...trail, ref];
    if (visited.has(ref)) return null;
    visiting.add(ref);
    const step = stepsByRef.get(ref);
    for (const dependency of step?.dependsOn ?? []) {
      if (!stepsByRef.has(dependency)) continue;
      const cycle = visit(dependency, [...trail, ref]);
      if (cycle) return cycle;
    }
    visiting.delete(ref);
    visited.add(ref);
    return null;
  }

  for (const ref of stepsByRef.keys()) {
    const cycle = visit(ref, []);
    if (cycle) return cycle;
  }
  return null;
}

export function validatePlanProposal(value) {
  const errors = [];

  if (!isRecord(value)) return { ok: false, errors: ["PlanProposal 必须是对象"] };
  checkAllowedKeys(value, TOP_LEVEL_KEYS, "$", errors);

  if (!READINESS_VALUES.has(value.readiness)) {
    errors.push("$.readiness 必须是 ready、partial 或 blocked");
  }
  if (!nonEmptyString(value.goal)) errors.push("$.goal 必须是非空字符串");

  if (!Array.isArray(value.understanding)) errors.push("$.understanding 必须是数组");
  if (!Array.isArray(value.steps)) errors.push("$.steps 必须是数组");
  if (!Array.isArray(value.openQuestions)) errors.push("$.openQuestions 必须是数组");

  const readings = Array.isArray(value.understanding) ? value.understanding : [];
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const questions = Array.isArray(value.openQuestions) ? value.openQuestions : [];

  const readingRefs = new Set();
  readings.forEach((reading, index) => {
    const path = `$.understanding[${index}]`;
    if (!isRecord(reading)) {
      errors.push(`${path} 必须是对象`);
      return;
    }
    checkAllowedKeys(reading, READING_KEYS, path, errors);
    if (!nonEmptyString(reading.ref) || !REF_PATTERN.test(reading.ref)) {
      errors.push(`${path}.ref 格式无效`);
    } else if (readingRefs.has(reading.ref)) {
      errors.push(`${path}.ref 与其他理解重复：${reading.ref}`);
    } else {
      readingRefs.add(reading.ref);
    }
    if (!nonEmptyString(reading.quote)) errors.push(`${path}.quote 必须是非空字符串`);
    if (!nonEmptyString(reading.reading)) errors.push(`${path}.reading 必须是非空字符串`);
  });

  const stepsByRef = new Map();
  steps.forEach((step, index) => {
    const path = `$.steps[${index}]`;
    if (!isRecord(step)) {
      errors.push(`${path} 必须是对象`);
      return;
    }
    checkAllowedKeys(step, STEP_KEYS, path, errors);
    if (!nonEmptyString(step.ref) || !REF_PATTERN.test(step.ref)) {
      errors.push(`${path}.ref 格式无效`);
    } else if (stepsByRef.has(step.ref)) {
      errors.push(`${path}.ref 与其他步骤重复：${step.ref}`);
    } else {
      stepsByRef.set(step.ref, step);
    }
    if (!nonEmptyString(step.title)) errors.push(`${path}.title 必须是非空字符串`);
    if (!nonEmptyString(step.intent)) errors.push(`${path}.intent 必须是非空字符串`);
    if (!nonEmptyString(step.output)) errors.push(`${path}.output 必须是非空字符串`);
    if ("input" in step && !nonEmptyString(step.input)) {
      errors.push(`${path}.input 存在时必须是非空字符串`);
    }
    checkStringArray(step.dependsOn, `${path}.dependsOn`, errors);
  });

  for (const [ref, step] of stepsByRef.entries()) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === ref) errors.push(`步骤 ${ref} 不能依赖自己`);
      else if (!stepsByRef.has(dependency)) errors.push(`步骤 ${ref} 引用了不存在的依赖 ${dependency}`);
    }
    /* 依赖了上一步，却说自己不吃任何东西——链路在这儿断了。 */
    if ((step.dependsOn?.length ?? 0) > 0 && !nonEmptyString(step.input)) {
      errors.push(`步骤 ${ref} 依赖了前序步骤，却没有说明它吃什么`);
    }
  }

  const cycle = findCycle(stepsByRef);
  if (cycle) errors.push(`步骤依赖存在环：${cycle.join(" -> ")}`);

  const questionRefs = new Set();
  questions.forEach((question, index) => {
    const path = `$.openQuestions[${index}]`;
    if (!isRecord(question)) {
      errors.push(`${path} 必须是对象`);
      return;
    }
    checkAllowedKeys(question, QUESTION_KEYS, path, errors);
    if (!nonEmptyString(question.ref) || !REF_PATTERN.test(question.ref)) {
      errors.push(`${path}.ref 格式无效`);
    } else if (questionRefs.has(question.ref)) {
      errors.push(`${path}.ref 与其他问题重复：${question.ref}`);
    } else {
      questionRefs.add(question.ref);
    }
    if (!nonEmptyString(question.question)) errors.push(`${path}.question 必须是非空字符串`);
    if (!nonEmptyString(question.reason)) errors.push(`${path}.reason 必须是非空字符串`);
    if (checkStringArray(question.affects, `${path}.affects`, errors)) {
      for (const affectedRef of question.affects) {
        if (!stepsByRef.has(affectedRef)) {
          errors.push(`${path}.affects 引用了不存在的步骤 ${affectedRef}`);
        }
      }
    }
  });

  if (value.readiness === "ready" && questions.length > 0) {
    errors.push("ready Plan 不能保留 openQuestions");
  }
  if (value.readiness === "partial" && (steps.length === 0 || questions.length === 0)) {
    errors.push("partial Plan 必须同时包含已知步骤和开放问题");
  }
  if (value.readiness === "blocked" && questions.length === 0) {
    errors.push("blocked Plan 必须说明需要用户回答的问题");
  }

  return { ok: errors.length === 0, errors };
}

async function runCli() {
  const file = process.argv[2];
  if (!file) {
    console.error("用法：node src/validate-plan-proposal.mjs <plan.json>");
    process.exitCode = 2;
    return;
  }

  try {
    const proposal = JSON.parse(await readFile(file, "utf8"));
    const result = validatePlanProposal(proposal);
    if (!result.ok) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log(`PlanProposal 校验通过：${file}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
