import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import type { ErrorObject } from 'ajv';
import type { PlanProposal, PlanStep } from '../../shared/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(here, "../../contracts/plan-proposal.schema.json"), "utf8")
);

/* schema 是唯一来源：字段表、必填、取值范围全从它来，这里不再抄一遍。
   生成端不依赖任何一家的强制（各家支持参差），这道闸门是唯一的保证：
   校不过就把错误发回去让模型重交。 */
const ajv = new Ajv({ allErrors: true, strict: true });
const checkShape = ajv.compile<PlanProposal>(schema);

function formatShapeError(error: ErrorObject): string {
  const at = error.instancePath || "$";
  if (error.keyword === "additionalProperties") {
    return `${at} 出现了 schema 里没有的字段：${error.params.additionalProperty}`;
  }
  if (error.keyword === "required") {
    return `${at} 缺少必填字段：${error.params.missingProperty}`;
  }
  if (error.keyword === "minLength") {
    return `${at} 不能是空字符串`;
  }
  if (error.keyword === "enum") {
    return `${at} 取值不在允许范围内（${error.params.allowedValues.join("、")}）`;
  }
  return `${at} ${error.message}`;
}

function findCycle(stepsByRef: Map<string, PlanStep>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(ref: string, trail: string[]): string[] | null {
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

/* 以下都是 JSON Schema 写不出来的：编号是否撞车、引用指向的东西存不存在、
   依赖会不会绕成环、readiness 跟 openQuestions 对不对得上。 */
export type PlanInspection = { ok: true; plan: PlanProposal; errors: string[] }
  | { ok: false; errors: string[] };

export function inspectPlanProposal(value: unknown): PlanInspection {
  if (!checkShape(value)) {
    return { ok: false, errors: (checkShape.errors ?? []).map(formatShapeError) };
  }

  const errors = [];
  const readingRefs = new Set();
  const stepsByRef = new Map<string, PlanStep>();
  const questionRefs = new Set();

  value.understanding.forEach((reading, index) => {
    if (readingRefs.has(reading.ref)) {
      errors.push(`$.understanding[${index}].ref 与其他理解重复：${reading.ref}`);
    }
    readingRefs.add(reading.ref);
  });

  value.steps.forEach((step, index) => {
    if (stepsByRef.has(step.ref)) {
      errors.push(`$.steps[${index}].ref 与其他步骤重复：${step.ref}`);
      return;
    }
    stepsByRef.set(step.ref, step);
  });

  for (const [ref, step] of stepsByRef.entries()) {
    for (const dependency of step.dependsOn) {
      if (dependency === ref) errors.push(`步骤 ${ref} 不能依赖自己`);
      else if (!stepsByRef.has(dependency)) {
        errors.push(`步骤 ${ref} 引用了不存在的依赖 ${dependency}`);
      }
    }
  }

  const cycle = findCycle(stepsByRef);
  if (cycle) errors.push(`步骤依赖存在环：${cycle.join(" -> ")}`);

  value.openQuestions.forEach((question, index) => {
    if (questionRefs.has(question.ref)) {
      errors.push(`$.openQuestions[${index}].ref 与其他问题重复：${question.ref}`);
    }
    questionRefs.add(question.ref);
    for (const affectedRef of question.affects) {
      if (!stepsByRef.has(affectedRef)) {
        errors.push(`$.openQuestions[${index}].affects 引用了不存在的步骤 ${affectedRef}`);
      }
    }
  });

  if (value.readiness === "ready" && value.openQuestions.length > 0) {
    errors.push("ready 的方案不该还留着没问清的信息");
  }
  if (value.readiness === "partial" && (value.steps.length === 0 || value.openQuestions.length === 0)) {
    errors.push("partial 的方案必须同时给出骨架和还缺什么");
  }

  return errors.length ? { ok: false, errors } : { ok: true, plan: value, errors };
}

// 原有公共校验结果保持形状不变；内部可直接取得同一次检查后的计划。
export function validatePlanProposal(value: unknown): { ok: boolean; errors: string[] } {
  const { ok, errors } = inspectPlanProposal(value);
  return { ok, errors };
}

async function runCli() {
  const file = process.argv[2];
  if (!file) {
    console.error("用法：node dist/src/plan/validate-plan-proposal.mjs <plan.json>");
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

// 给内部调用方的收窄入口：同样经过 Schema 与语义检查，不是类型断言。
export function isPlanProposal(value: unknown): value is PlanProposal {
  return validatePlanProposal(value).ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
