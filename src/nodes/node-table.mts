import type { NodeDefinition } from "../../shared/contracts.mjs";
import type { ErrorObject } from "ajv";
import { isRecord } from "../../shared/json.mjs";
/* 节点表:我们自己定义的节点,一个节点一个文件(nodes/*.json),契约在 contracts/node-definition.schema.json。
   一张表喂三处:执行者照它填、闸门照它查、卡照它画。这里只做两件事:
   把文件读进来按契约校一遍(有一个校不过整张表就不上桌,错的表比没有表更糟),按 type 找一个。 */
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { KINDS } from "../../web/flow.mjs";

const contractUrl = new URL("../../contracts/node-definition.schema.json", import.meta.url);
const nodesDir = new URL("../../nodes/", import.meta.url);

const ajv = new Ajv({ allErrors: true, strict: true });
const checkShape = ajv.compile<NodeDefinition>(JSON.parse(readFileSync(contractUrl, "utf8")));

function formatShapeError(error: ErrorObject) {
  const at = error.instancePath || "$";
  if (error.keyword === "additionalProperties") return `${at} 出现了契约里没有的字段:${error.params.additionalProperty}`;
  if (error.keyword === "required") return `${at} 缺少必填字段:${error.params.missingProperty}`;
  if (error.keyword === "minLength") return `${at} 不能是空字符串`;
  if (error.keyword === "enum") return `${at} 取值不在允许范围内(${error.params.allowedValues.join("、")})`;
  return `${at} ${error.message}`;
}

/* 契约管一格一格的形状;这里补契约写不出的几条(JSON Schema 的 if/then 过不了 ajv 的严格模式,索性都放这儿):
   挑一个必须给 options、不是挑一个的没有 options,默认值得是能挑的值之一,key 不许重。 */
export function checkNodeDefinition(definition: unknown): string[] {
  const reasons = checkShape(definition) ? [] : (checkShape.errors ?? []).map(formatShapeError);
  const seen = new Set<unknown>();
  const record = isRecord(definition) ? definition : {};
  const slots: unknown[] = Array.isArray(record.slots) ? record.slots : [];
  for (const slot of slots) {
    if (!isRecord(slot)) continue;
    if (seen.has(slot.key)) reasons.push(`格子 ${slot.key} 重复`);
    seen.add(slot.key);
    if (slot.kind === "pick" && !slot.options) reasons.push(`格子 ${slot.key} 是挑一个,却没给 options`);
    if (slot.kind !== "pick" && slot.options) reasons.push(`格子 ${slot.key} 不是挑一个,不该有 options`);
    if (slot.options && slot.default !== undefined && (!Array.isArray(slot.options) || !slot.options.includes(slot.default))) {
      reasons.push(`格子 ${slot.key} 的默认值 ${slot.default} 不在 options 里`);
    }
  }
  /* 出口那两样也有契约写不出的:加的东西看某一格的,那一格得真有、得是挑一个、挑的得是流里的种类;
     起点(不进数据)不能说「跟进来的一样」——它前面没有东西可跟。 */
  const output = isRecord(record.output) ? record.output : {};
  const adds = output.adds;
  if (typeof adds === "string" && adds.startsWith("slot:")) {
    const key = adds.slice(5);
    const slot = slots.filter(isRecord).find((s) => s.key === key);
    if (!slot) reasons.push(`出口说看 ${key} 这一格,表里没有这一格`);
    else if (slot.kind !== "pick" || (!Array.isArray(slot.options) || !slot.options.every((o: unknown) => KINDS.some((kind) => kind === o)))) {
      reasons.push(`出口看的那一格 ${key} 得是挑一个,挑的只能是:${KINDS.join("、")}`);
    }
  }
  if (!record.input && output.per === "same") reasons.push("起点不进数据,出去的得说按什么算一条,不能写 same");
  return reasons;
}

export function loadNodeTable(dir: URL | string = nodesDir): NodeDefinition[] {
  const base = dir instanceof URL ? dir : pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`);
  const table: NodeDefinition[] = [];
  for (const file of readdirSync(base).filter((f) => f.endsWith(".json")).sort()) {
    const definition: unknown = JSON.parse(readFileSync(new URL(file, base), "utf8"));
    if (!isNodeDefinition(definition)) throw new Error(`nodes/${file} 不合节点定义的契约:\n${checkNodeDefinition(definition).join("\n")}`);
    if (table.some((n) => n.type === definition.type)) throw new Error(`nodes/${file} 的 type ${definition.type} 已经有了`);
    table.push(definition);
  }
  return table;
}

export function isNodeDefinition(value: unknown): value is NodeDefinition {
  return checkNodeDefinition(value).length === 0;
}

let cached: NodeDefinition[] | null = null;
export const nodeTable = () => (cached ??= loadNodeTable());
export const findNodeDefinition = (type: string) => nodeTable().find((n) => n.type === type) ?? null;
