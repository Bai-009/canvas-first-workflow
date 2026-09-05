import type { CanvasNode, Edge } from '../../shared/contracts.mjs';
import type { Flow, FlowCanvas } from '../../shared/flow.mjs';
/* 三道验证里的第二道:交回的节点对得上节点表。
   类型在表里;params 的键都是它的格;空位都是它的格;要填的格填了、留空了或有默认值;
   挑一个的值在能挑的里面;填个数的是数;多出口节点的线写了出口、单出口的没写。
   闸门只拦机器缺了转不动的:值对不对、旁白好不好,不归它。 */
import { findNodeDefinition, nodeTable } from "./node-table.mjs";
import { edgeKey, flows, join } from "../../web/flow.mjs";

const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

export function checkAgainstNodeTable(nodes: CanvasNode[], edges: Edge[], canvasNodes: CanvasNode[] = []) {
  const reasons = [];
  for (const node of nodes) {
    const def = findNodeDefinition(node.type);
    const label = `节点 ${node.name}`;
    if (!def) {
      reasons.push(`${label} 的类型 ${node.type} 不在节点表里,有:${nodeTable().map((n) => n.type).join("、")}`);
      continue;
    }
    const keys = def.slots.map((s) => s.key);
    for (const key of Object.keys(node.params)) {
      if (!keys.includes(key)) reasons.push(`${label}(${def.type})没有 ${key} 这一格,有:${keys.join("、") || "没有格子"}`);
    }
    for (const key of node.blanks) if (!keys.includes(key)) reasons.push(`${label} 的空位 ${key} 不是它的格`);
    for (const slot of def.slots) {
      const value = node.params[slot.key];
      const given = !isEmpty(value);
      if (!given && !node.blanks.includes(slot.key) && slot.default === undefined && slot.required !== false) {
        reasons.push(`${label} 的 ${slot.key} 没填也没留空`);
      }
      if (given && slot.kind === "pick" && !(slot.options ?? []).some((option) => option === value)) reasons.push(`${label} 的 ${slot.key} 只能是:${(slot.options ?? []).join("、")}`);
      if (given && slot.kind === "number" && typeof value !== "number") reasons.push(`${label} 的 ${slot.key} 要填个数`);
    }
  }
  const byName = new Map([...canvasNodes, ...nodes].map((n) => [n.name, n]));
  for (const edge of edges) {
    const source = byName.get(edge.from);
    const def = source && findNodeDefinition(source.type);
    if (!def) continue;
    const label = `线 ${edge.from}→${edge.to}`;
    if (def.ports && !def.ports.some((port) => port === edge.output)) reasons.push(`${label} 要写出口,${edge.from} 有:${def.ports.join("、")}`);
    if (!def.ports && edge.output !== undefined) reasons.push(`${label} 写了出口 ${edge.output},${edge.from} 只有一个出口`);
  }
  return reasons;
}

/* 接得上:每个节点要什么,接进来的线上得有。数据往下走前面的都带着,所以查的是上游一路
   加进来的全部,不是紧挨着那一个——分岔 false 路上的 OCR 照样拿得到文件。
   canvas 是这一步进去之后整张画布的样子(节点、线都换好了),线上流的从它推。
   只拦能确定为假的:上游有一张不知道加了什么的卡(没申报出口的写代码卡),就不知道,不拦。 */
export function checkFlow(mine: CanvasNode[], canvas: Required<FlowCanvas>) {
  const reasons = [];
  const f = flows(nodeTable(), canvas);
  for (const node of mine) {
    const needs = findNodeDefinition(node.type)?.input?.needs;
    if (!needs) continue;
    const ins = canvas.edges.filter((e) => e.to === node.name).map((e) => f.edges.get(edgeKey(e))).filter((flow): flow is Flow => flow !== undefined);
    if (!ins.length) { reasons.push(`节点 ${node.name} 要 ${needs},没有一根线进来`); continue; }
    const into = join(ins);
    if (into.unknown || into.carries.includes(needs)) continue;
    reasons.push(`节点 ${node.name} 要 ${needs},接进来的线上只有 ${into.carries.join("、") || "空的"}`);
  }
  return reasons;
}
