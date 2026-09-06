import { isRecord } from "../../shared/json.mjs";
import type { ModelTool } from "../../shared/model.mjs";
import { readFileSync } from "node:fs";

/* 修订工具和本地闸门读同一份契约。返回的是候选 diff,这里没有提交画布的权力。 */
const contractUrl = new URL("../../contracts/workflow-revision.schema.json", import.meta.url);
const schema: unknown = JSON.parse(readFileSync(contractUrl, "utf8"));
if (!isRecord(schema)) throw new Error("提交工具 Schema 必须是对象");
const { $schema, $id, title, ...parameters } = schema;

export const submitRevisionTool: ModelTool = {
  type: "function",
  function: {
    name: "submit_revision",
    description:
      "Return one candidate revision after reviewing every step of the current workflow. " +
      "The target is where the user initiated the request, not the scope of permissible changes. " +
      "With patch, submit only necessary node and edge changes across any existing steps; " +
      "with unchanged or needs_plan, provide explanations without any change arrays. " +
      "This tool validates a candidate; the host decides whether to commit it. It never executes business data.",
    parameters,
  },
};
