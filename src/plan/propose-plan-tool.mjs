import { readFileSync } from "node:fs";

// 工具的参数定义直接来自契约文件,不手抄第二份。
// $schema/$id/title 是契约文件自己的元数据,不属于工具参数,去掉;其余原样保留。
// 各家模型对"生成时强制符合 schema"的支持参差不齐,所以这份 schema 对模型只是说明书,
// 真正的强制在闸门(validate-plan-proposal.mjs):校不过就打回重试。
const contractUrl = new URL("../../contracts/plan-proposal.schema.json", import.meta.url);
/* 契约文件顶层的 description 不进工具参数:真模型两次都把它当成一个字段填了进来
   (run5、run6 首轮各被闸门打回一次)。它说的"每一轮都是完整的一份"在工具说明里另有一句。 */
const { $schema, $id, title, description: _contractNote, ...parameters } = JSON.parse(
  readFileSync(contractUrl, "utf8")
);

export const proposePlanTool = {
  name: "propose_plan",
  description:
    "提交一份完整的数据处理链路设计方案。只在链路画得出来的时候调用:" +
    "用户手上的数据形态判得出来,从它到目标形态的转变排得出来。" +
    "判不出来就不要调用,直接向用户提问。" +
    "每次调用都提交完整的一份,不是上一份的改动。",
  parameters,
};
