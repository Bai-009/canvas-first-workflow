import { isRecord } from "../../shared/json.mjs";
import type { ModelTool } from "../../shared/model.mjs";
import { readFileSync } from "node:fs";

/* 执行者交回一步用的动作。参数定义直接来自契约文件,不手抄第二份;
   $schema/$id/title 是契约文件自己的元数据,不进工具参数。
   跟 propose_plan 一样,这份 schema 对模型只是说明书,强制在状态机的闸门里。 */
const contractUrl = new URL("../../contracts/step-submission.schema.json", import.meta.url);
const schema: unknown = JSON.parse(readFileSync(contractUrl, "utf8"));
if (!isRecord(schema)) throw new Error("提交工具 Schema 必须是对象");
const { $schema, $id, title, ...parameters } = schema;

export const submitStepTool: ModelTool = {
  type: "function",
  function: {
    name: "submit_step",
    description:
      "Hand in the result for the current step. Call it exactly once, at the end. " +
      "With kind \"patch\", provide every node and edge of this step: the full set, not a diff; the step's previous nodes are replaced. " +
      "With kind \"covered\", the step's existing nodes stay as they are; omit nodes and edges.",
    parameters,
  },
};
