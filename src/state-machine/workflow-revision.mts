import type { Canvas, CanvasNode, Edge, PlanProposal, RevisionResult } from '../../shared/contracts.mjs';
import type { RevisionContext } from '../../shared/workflow.mjs';
import { isRecord as object } from '../../shared/json.mjs';

type RevisionCheck = { ok: false; reasons: string[] }
  | { ok: true; kind: 'patch'; reasons: string[]; result: Extract<RevisionResult, { kind: 'patch' }>; candidate: Canvas; changes: string[] }
  | { ok: true; kind: 'unchanged' | 'needs_plan'; reasons: string[]; result: Exclude<RevisionResult, { kind: 'patch' }> };

import { checkAgainstNodeTable, checkFlow } from "../nodes/check-nodes.mjs";
import { readFileSync } from "node:fs";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";

const checkShape = new Ajv({ strict: true, allErrors: true }).compile<RevisionResult>(
  JSON.parse(readFileSync(new URL("../../contracts/workflow-revision.schema.json", import.meta.url), "utf8"))
);

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const edgeKey = (edge: Edge) => JSON.stringify([edge.from, edge.to, edge.output ?? null]);
const diffKeys = ["upsertNodes", "removeNodes", "addEdges", "removeEdges"] as const;
const extraKeys = (value: object, allowed: readonly string[]) => Object.keys(value).filter((key) => !allowed.includes(key));

/* JSON 对象的键顺序不算改动；节点和线的数组顺序也不是修订内容。 */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function nodeProblems(node: unknown) {
  if (!object(node)) return ["节点不是对象"];
  const reasons = [];
  for (const key of ["name", "step", "type"]) if (!text(node[key])) reasons.push(`节点缺少有效的 ${key}`);
  if (!object(node.params)) reasons.push(`节点 ${node.name ?? ""} 的 params 不是对象`);
  if (!Array.isArray(node.blanks) || node.blanks.some((key) => !text(key))) reasons.push(`节点 ${node.name ?? ""} 的 blanks 不是字符串数组`);
  else if (new Set(node.blanks).size !== node.blanks.length) reasons.push(`节点 ${node.name} 的 blanks 重复`);
  if (node.note !== undefined && typeof node.note !== "string") reasons.push(`节点 ${node.name} 的 note 不是字符串`);
  for (const key of extraKeys(node, ["name", "step", "type", "params", "blanks", "note"])) reasons.push(`节点 ${node.name ?? ""} 有未知字段 ${key}`);
  return reasons;
}

function edgeProblems(edge: unknown) {
  if (!object(edge) || !text(edge.from) || !text(edge.to)) return ["线必须有有效的 from 和 to"];
  const reasons = [];
  if (edge.output !== undefined && !text(edge.output)) reasons.push(`线 ${edge.from}→${edge.to} 的 output 不是有效字符串`);
  for (const key of extraKeys(edge, ["from", "to", "output"])) reasons.push(`线 ${edge.from}→${edge.to} 有未知字段 ${key}`);
  return reasons;
}

/* 全图硬检查。只检查已有机器契约：节点、参数、依赖线、端点、环和粗数据种类。
   不解读代码或 outputSchema 字段；review 是模型的影响说明，不是这道检查的证据。 */
export function inspectCanvas(canvas: unknown, plan: PlanProposal): string[] {
  if (!object(canvas) || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) return ["画布必须包含 nodes 和 edges 数组"];
  const reasons = [...canvas.nodes.flatMap(nodeProblems), ...canvas.edges.flatMap(edgeProblems)];
  if (reasons.length) return reasons;
  // 上面的逐字段检查已验证数组元素；后续只读取通过检查的节点与线。
  const nodes = canvas.nodes as CanvasNode[];
  const edges = canvas.edges as Edge[];
  const steps = new Map(plan.steps.map((step) => [step.ref, step]));
  const names = new Set<string>();
  for (const node of nodes) {
    if (names.has(node.name)) reasons.push(`节点名 ${node.name} 重复`);
    names.add(node.name);
    if (!steps.has(node.step)) reasons.push(`节点 ${node.name} 属于方案里没有的步骤 ${node.step}`);
  }
  const edgeNames = new Set<string>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (edgeNames.has(key)) reasons.push(`线 ${edge.from}→${edge.to} 重复`);
    edgeNames.add(key);
    if (!names.has(edge.from) || !names.has(edge.to)) reasons.push(`线 ${edge.from}→${edge.to} 接了不存在的节点`);
  }
  if (reasons.length) return reasons;

  const byName = new Map(nodes.map((node) => [node.name, node]));
  for (const step of plan.steps) {
    const mine = new Set(nodes.filter((node) => node.step === step.ref).map((node) => node.name));
    if (!mine.size) { reasons.push(`${step.ref} 在画布上没有节点`); continue; }
    for (const dependency of step.dependsOn ?? []) {
      if (!edges.some((edge) => byName.get(edge.from)?.step === dependency && mine.has(edge.to))) {
        reasons.push(`${step.ref} 接在 ${dependency} 后面,画布上却没有一条线从 ${dependency} 接到 ${step.ref}`);
      }
    }
    /* 一步里的节点仍须连成一片：内部相连，或几条分支共享同一个上游。
       只取进本步和本步内部的线，不能借共同下游把两张孤立卡当成已接好。
       不同步骤各自有独立起点是合法的，不要求整份方案只有一个根。 */
    if (mine.size > 1) {
      const near = new Map<string, Set<string>>();
      const link = (from: string, to: string) => {
        if (!near.has(from)) near.set(from, new Set());
        near.get(from)?.add(to);
      };
      for (const edge of edges) if (mine.has(edge.to)) {
        link(edge.from, edge.to);
        link(edge.to, edge.from);
      }
      const reached = new Set<string>([...mine].slice(0, 1));
      const pending = [...reached];
      while (pending.length) {
        for (const next of near.get(pending.pop() ?? "") ?? []) if (!reached.has(next)) {
          reached.add(next);
          pending.push(next);
        }
      }
      const isolated = [...mine].filter((name) => !reached.has(name));
      if (isolated.length) reasons.push(`${step.ref} 的节点 ${isolated.join("、")} 没跟这一步的其他节点连在一起`);
    }
  }
  const left = new Map(nodes.map((node) => [node.name, 0]));
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.name, []]));
  for (const edge of edges) {
    left.set(edge.to, (left.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const ready = [...left].filter(([, count]) => count === 0).map(([name]) => name);
  let visited = 0;
  for (let i = 0; i < ready.length; i += 1) {
    visited += 1;
    for (const next of outgoing.get(ready[i] ?? "") ?? []) {
      left.set(next, (left.get(next) ?? 0) - 1);
      if (left.get(next) === 0) ready.push(next);
    }
  }
  if (visited !== nodes.length) reasons.push("画布的连线存在环");
  reasons.push(...checkAgainstNodeTable(nodes, edges));
  if (!reasons.length) reasons.push(...checkFlow(nodes, { nodes, edges }));
  return reasons;
}

/* 完整工作流修订的两道入口共用这一个纯函数：模型内部退回重交；会话提交前再查。
   先在副本上应用差量，再查整图，任何一处失败都不产出可提交的 candidate。 */
export function readRevision(result: unknown, context: RevisionContext): RevisionCheck {
  const reasons: string[] = [];
  if (!object(result)) return { ok: false, reasons: ["修订结果不是对象"] };
  if (!["patch", "unchanged", "needs_plan"].some((kind) => kind === result.kind)) reasons.push("修订 kind 只能是 patch、unchanged 或 needs_plan");
  if (!text(result.summary)) reasons.push("修订结果缺少 summary");
  const allowed = ["kind", "summary", "review", ...(result.kind === "patch" ? diffKeys : [])];
  for (const key of extraKeys(result, allowed)) reasons.push(`修订结果不允许字段 ${key}`);
  const steps = new Set(context.plan.steps.map((step) => step.ref));
  if (!Array.isArray(result.review)) reasons.push("review 必须逐步说明整份方案");
  else {
    const reviewed = new Set<string>();
    for (const item of result.review) {
      if (!object(item) || !text(item.step) || !text(item.summary)) { reasons.push("review 的每一条必须有 step 和 summary"); continue; }
      if (extraKeys(item, ["step", "summary"]).length) reasons.push(`review ${item.step} 有未知字段`);
      if (!steps.has(item.step)) reasons.push(`review 指向方案里没有的步骤 ${item.step}`);
      if (reviewed.has(item.step)) reasons.push(`review 重复说明了 ${item.step}`);
      reviewed.add(item.step);
    }
    for (const step of steps) if (!reviewed.has(step)) reasons.push(`review 缺少 ${step} 的影响说明`);
  }
  if (!checkShape(result)) {
    reasons.push(...(checkShape.errors ?? []).map((error) => {
      const at = error.instancePath || "$";
      if (error.keyword === "required") return `${at} 缺少 ${error.params.missingProperty}`;
      if (error.keyword === "additionalProperties") return `${at} 不允许字段 ${error.params.additionalProperty}`;
      return `${at} ${error.message}`;
    }));
    return { ok: false, reasons };
  }
  if (reasons.length) return { ok: false, reasons };
  if (result.kind !== "patch") return { ok: true, kind: result.kind, result, reasons };
  for (const key of diffKeys) if (!Array.isArray(result[key])) reasons.push(`${key} 必须是数组`);
  if (reasons.length) return { ok: false, reasons };
  reasons.push(...result.upsertNodes.flatMap(nodeProblems), ...result.addEdges.flatMap(edgeProblems), ...result.removeEdges.flatMap(edgeProblems));
  if (result.removeNodes.some((name) => !text(name))) reasons.push("removeNodes 必须是节点名数组");
  if (reasons.length) return { ok: false, reasons };

  const base = context.canvas;
  const nodes = new Map(base.nodes.map((node) => [node.name, node]));
  const upserted = new Set<string>();
  const removed = new Set<string>();
  for (const name of result.removeNodes) {
    if (removed.has(name)) reasons.push(`removeNodes 重复删除 ${name}`);
    if (!nodes.has(name)) reasons.push(`不能删除不存在的节点 ${name}`);
    removed.add(name);
  }
  for (const node of result.upsertNodes) {
    if (upserted.has(node.name)) reasons.push(`upsertNodes 重复提交 ${node.name}`);
    if (removed.has(node.name)) reasons.push(`节点 ${node.name} 不能同时删除和更新`);
    upserted.add(node.name);
  }
  if (removed.has(context.target.node)) reasons.push("发起指令的节点必须保留；需要删除它时请交 needs_plan");
  const target = result.upsertNodes.find((node) => node.name === context.target.node);
  if (target && target.step !== context.target.step) reasons.push("发起指令的节点不能转移所属步骤；需要改方案时请交 needs_plan");

  const edges = new Map(base.edges.map((edge) => [edgeKey(edge), edge]));
  const removedEdges = new Set<string>();
  const addedEdges = new Set<string>();
  for (const edge of result.removeEdges) {
    const key = edgeKey(edge);
    if (removedEdges.has(key)) reasons.push(`removeEdges 重复删除 ${edge.from}→${edge.to}`);
    if (!edges.has(key)) reasons.push(`不能删除不存在的线 ${edge.from}→${edge.to}`);
    removedEdges.add(key);
  }
  for (const edge of result.addEdges) {
    const key = edgeKey(edge);
    if (addedEdges.has(key) || edges.has(key)) reasons.push(`addEdges 重复添加 ${edge.from}→${edge.to}`);
    addedEdges.add(key);
  }
  if (reasons.length) return { ok: false, reasons };
  for (const name of removed) nodes.delete(name);
  for (const node of result.upsertNodes) nodes.set(node.name, node);
  for (const key of removedEdges) edges.delete(key);
  for (const edge of result.addEdges) edges.set(edgeKey(edge), edge);
  const candidate = structuredClone({ ...base, nodes: [...nodes.values()], edges: [...edges.values()] });
  reasons.push(...inspectCanvas(candidate, context.plan));
  if (reasons.length) return { ok: false, reasons };
  const before = new Map(base.nodes.map((node) => [node.name, node]));
  const changes = new Set(result.upsertNodes.filter((node) => !same(node, before.get(node.name))).map((node) => node.name));
  for (const name of removed) changes.add(name);
  for (const edge of [...result.addEdges, ...result.removeEdges]) { changes.add(edge.from); changes.add(edge.to); }
  if (!changes.size) return { ok: false, reasons: ["patch 没有实际改动；没有需要修改的内容请交 unchanged"] };
  return { ok: true, kind: "patch", result, reasons, candidate, changes: [...changes] };
}

// 保留既有只读检查 API 的返回形状；内部提交使用携带已验证结果的 readRevision。
export function inspectRevision(result: unknown, context: RevisionContext): { reasons: string[]; candidate?: Canvas; changes?: string[] } {
  const checked = readRevision(result, context);
  return checked.ok && checked.kind === 'patch'
    ? { reasons: checked.reasons, candidate: checked.candidate, changes: checked.changes }
    : { reasons: checked.reasons };
}
