import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { proposePlanTool } from "../src/propose-plan-tool.mjs";

const contractUrl = new URL("../contracts/plan-proposal.schema.json", import.meta.url);
const contract = JSON.parse(readFileSync(contractUrl, "utf8"));

test("工具叫 propose_plan,带说明", () => {
  assert.equal(proposePlanTool.name, "propose_plan");
  assert.ok(proposePlanTool.description.length > 0);
});

test("工具参数就是契约本身,改了契约这里自动跟着变", () => {
  const { $schema, $id, title, ...expected } = contract;
  assert.deepEqual(proposePlanTool.parameters, expected);
});

test("契约文件自己的元数据不进工具参数", () => {
  assert.ok(!("$schema" in proposePlanTool.parameters));
  assert.ok(!("$id" in proposePlanTool.parameters));
  assert.ok(!("title" in proposePlanTool.parameters));
});
