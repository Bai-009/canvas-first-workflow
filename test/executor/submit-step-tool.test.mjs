import test from "node:test";
import assert from "node:assert/strict";
import { submitStepTool } from "../../dist/src/executor/submit-step-tool.mjs";

/* 每一层对象都不许自己加格子;params 例外,它装的是格子的值,键名由节点表定,契约上不封死,闸门第二道按表查 */
function objectsIn(schema, path = "") {
  const found = [];
  if (schema && typeof schema === "object") {
    if (schema.type === "object") found.push({ path, schema });
    for (const [key, child] of Object.entries(schema.properties ?? {})) found.push(...objectsIn(child, `${path}/${key}`));
    if (schema.items) found.push(...objectsIn(schema.items, `${path}[]`));
  }
  return found;
}

test("交步工具:名字、三种格子、契约元数据不进参数", () => {
  const { name, parameters } = submitStepTool.function;
  assert.equal(name, "submit_step");
  assert.deepEqual(Object.keys(parameters.properties), ["kind", "nodes", "edges"]);
  assert.deepEqual(parameters.properties.kind.enum, ["patch", "covered"]);
  assert.deepEqual(parameters.required, ["kind"]);
  for (const meta of ["$schema", "$id", "title"]) assert.equal(meta in parameters, false);
});

test("交步工具:节点四格必填,note 有位子但不强制,线上出口可选,除 params 外每层封死", () => {
  const { parameters } = submitStepTool.function;
  const node = parameters.properties.nodes.items;
  assert.deepEqual(node.required, ["name", "type", "params", "blanks"]);
  assert.equal(typeof node.properties.note.description, "string");
  const edge = parameters.properties.edges.items;
  assert.deepEqual(edge.required, ["from", "to"]);
  assert.match(edge.properties.output.description, /true.*false/s);
  for (const { path, schema } of objectsIn(parameters)) {
    if (path.endsWith("/params")) assert.equal("additionalProperties" in schema, false, `${path} 不能封死`);
    else assert.equal(schema.additionalProperties, false, `${path} 没封`);
  }
});
