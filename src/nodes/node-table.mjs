/* 节点表:我们自己定义的节点,一个节点一个文件(nodes/*.json),契约在 contracts/node-definition.schema.json。
   一张表喂三处:执行者照它填、闸门照它查、卡照它画。这里只做两件事:
   把文件读进来按契约校一遍(有一个校不过整张表就不上桌,错的表比没有表更糟),按 type 找一个。 */
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Ajv from "ajv/dist/2020.js";

const contractUrl = new URL("../../contracts/node-definition.schema.json", import.meta.url);
const nodesDir = new URL("../../nodes/", import.meta.url);

const ajv = new Ajv({ allErrors: true, strict: true });
const checkShape = ajv.compile(JSON.parse(readFileSync(contractUrl, "utf8")));

function formatShapeError(error) {
  const at = error.instancePath || "$";
  if (error.keyword === "additionalProperties") return `${at} 出现了契约里没有的字段:${error.params.additionalProperty}`;
  if (error.keyword === "required") return `${at} 缺少必填字段:${error.params.missingProperty}`;
  if (error.keyword === "minLength") return `${at} 不能是空字符串`;
  if (error.keyword === "enum") return `${at} 取值不在允许范围内(${error.params.allowedValues.join("、")})`;
  return `${at} ${error.message}`;
}

/* 契约管一格一格的形状;这里补契约写不出的几条(JSON Schema 的 if/then 过不了 ajv 的严格模式,索性都放这儿):
   挑一个必须给 options、不是挑一个的没有 options,默认值得是能挑的值之一,key 不许重。 */
export function checkNodeDefinition(definition) {
  const reasons = checkShape(definition) ? [] : checkShape.errors.map(formatShapeError);
  const seen = new Set();
  for (const slot of Array.isArray(definition?.slots) ? definition.slots : []) {
    if (typeof slot !== "object" || slot === null) continue;
    if (seen.has(slot.key)) reasons.push(`格子 ${slot.key} 重复`);
    seen.add(slot.key);
    if (slot.kind === "pick" && !slot.options) reasons.push(`格子 ${slot.key} 是挑一个,却没给 options`);
    if (slot.kind !== "pick" && slot.options) reasons.push(`格子 ${slot.key} 不是挑一个,不该有 options`);
    if (slot.options && slot.default !== undefined && !slot.options.includes(slot.default)) {
      reasons.push(`格子 ${slot.key} 的默认值 ${slot.default} 不在 options 里`);
    }
  }
  return reasons;
}

export function loadNodeTable(dir = nodesDir) {
  const base = dir instanceof URL ? dir : pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`);
  const table = [];
  for (const file of readdirSync(base).filter((f) => f.endsWith(".json")).sort()) {
    const definition = JSON.parse(readFileSync(new URL(file, base), "utf8"));
    const reasons = checkNodeDefinition(definition);
    if (reasons.length) throw new Error(`nodes/${file} 不合节点定义的契约:\n${reasons.join("\n")}`);
    if (table.some((n) => n.type === definition.type)) throw new Error(`nodes/${file} 的 type ${definition.type} 已经有了`);
    table.push(definition);
  }
  return table;
}

let cached = null;
export const nodeTable = () => (cached ??= loadNodeTable());
export const findNodeDefinition = (type) => nodeTable().find((n) => n.type === type) ?? null;
