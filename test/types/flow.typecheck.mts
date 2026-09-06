// 只由 typecheck 检查，不运行这些故意错误的调用。
import { edgeKey, flows, join, label } from "../../web/flow.mjs";
import type { CanvasFlows, Flow, FlowCanvas, FlowDefinition } from "../../shared/flow.mjs";

const table: FlowDefinition[] = [
  { type: "readFile", output: { adds: "File", per: "文件" } },
  { type: "ocr", output: { adds: "Text", per: "same" } },
];
const canvas: FlowCanvas = {
  nodes: [{ name: "读", type: "readFile" }, { name: "识", type: "ocr", params: { model: "demo" } }],
  edges: [{ from: "读", to: "识" }],
};
const result: CanvasFlows = flows(table, canvas);
const text: string = label(result.out.get("识"));
void text;
join([{ head: "Text", carries: ["File", "Text"], per: "文件" }]);

// @ts-expect-error 连线缺少终点，不能进入共用数据流计算。
edgeKey({ from: "读" });
// @ts-expect-error 节点名称不能用对象代替。
flows(table, { nodes: [{ name: { name: "读" }, type: "readFile" }] });
// @ts-expect-error 输出数据种类必须来自已有契约。
flows([{ type: "ocr", output: { adds: "Picture", per: "文件" } }], canvas);
// @ts-expect-error 汇合输入必须带有完整的数据流信息。
join([{ head: "Text", carries: ["Text"] }]);
// @ts-expect-error 查找可能没有结果，调用方必须处理缺失节点。
const missing: Flow = result.out.get("不存在");
void missing;
