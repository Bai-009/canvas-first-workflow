/* 线上流的是什么。

   数据往下走,前面的东西都带着(架构.md「节点定义」):读文件加上文件,解析加上文本,
   向量化加上向量。所以一根线上流的不是「一种东西」,是上游一路加进来的全部;
   再加一样「按什么算一条」——每个文件一条、每块一条。

   这两样都从节点定义推,不猜:定义里写「要什么、加什么、按什么算一条」。
   浏览器印在线上,闸门拿它查接不接得上,状态机拿它比改前改后——三处一份代码,
   所以这个文件不引任何东西,浏览器和服务端都直接拿。 */

export const KINDS = ["Event", "File", "Text", "JSON", "Vector", "Result"] as const;

export type DataKind = typeof KINDS[number];
type OneOrMany<T> = T | T[] | null;

// 只描述本模块读取的部分，不冒充完整节点或方案契约。
export interface FlowNode {
  name: string;
  type: string;
  params?: Readonly<Record<string, unknown>>;
}
export interface FlowEdge { from: string; to: string; output?: string }
export interface FlowCanvas { nodes?: readonly FlowNode[]; edges?: readonly FlowEdge[] }
export interface FlowDefinition {
  type: string;
  output?: { adds?: DataKind | `slot:${string}` | null; per?: string };
}
export interface Flow {
  head: OneOrMany<DataKind>;
  carries: DataKind[];
  per: OneOrMany<string>;
  unknown?: boolean;
}
export interface CanvasFlows { edges: Map<string, Flow>; out: Map<string, Flow> }

const isKind = (value: unknown): value is DataKind => KINDS.some((kind) => kind === value);
const isSlot = (value: DataKind | `slot:${string}`): value is `slot:${string}` => value.startsWith("slot:");

export const edgeKey = (e: FlowEdge): string => `${e.from}>${e.to}>${e.output ?? ""}`;

/* 一个节点往流里加什么。定义里写死的直接用;写 slot:xxx 的(写代码那张)看这个节点
   自己填的格,没填就是不知道加了什么——不知道就印不知道,不替它编一个。 */
export function adds(def: FlowDefinition | undefined, node?: FlowNode): DataKind | null {
  const a = def?.output?.adds;
  if (a === null || a === undefined) return null;
  if (isSlot(a)) {
    const v = node?.params?.[a.slice(5)];
    return isKind(v) ? v : null;
  }
  return a;
}

const EMPTY: Flow = { head: null, carries: [], per: null };
const uniq = <T,>(list: readonly (T | T[] | null | undefined)[]): T[] =>
  [...new Set(list.flatMap((value) => value == null ? [] : Array.isArray(value) ? value : [value]))];
const one = <T,>(list: T[]): OneOrMany<T> => (list.length === 0 ? null : list.length === 1 ? list[0] ?? null : list);

/* 几路汇进同一个节点:带着的东西合起来;单位不同就都留着,印的时候一起印,不挑一个。
   有一路不知道,合起来就不知道。 */
export function join(list: readonly Flow[]): Flow {
  if (!list.length) return EMPTY;
  return {
    head: one(uniq(list.map((f) => f.head))),
    carries: uniq(list.map((f) => f.carries)),
    per: one(uniq(list.map((f) => f.per))),
    ...(list.some((f) => f.unknown) ? { unknown: true } : {}),
  };
}

/* 不知道加了什么的两种:不在表里的类型,和没申报出口的写代码卡。上游有一个不知道,
   下游就都不知道——闸门只拦能确定为假的,不知道不拦。 */
function through(def: FlowDefinition | undefined, node: FlowNode, into: Flow): Flow {
  const a = adds(def, node);
  const blind = !def || (typeof def.output?.adds === "string" && def.output.adds.startsWith("slot:") && a === null);
  return {
    head: a ?? into.head,
    carries: a && !into.carries.includes(a) ? [...into.carries, a] : into.carries,
    per: def?.output?.per === "same" || !def?.output?.per ? into.per : def.output.per,
    ...(into.unknown || blind ? { unknown: true } : {}),
  };
}

/* 整张画布,每根线、每个节点出口上流的是什么。
   返回 { edges: Map(线的 key → flow), out: Map(节点名 → flow) },flow = { head, carries, per }:
   head 是最后加进来的那一样(线上印它),carries 是全部(闸门查它),per 是按什么算一条。
   先按上下游顺序走一遍;有环的那几个排在最后,再补一遍让它们也收敛。 */
export function flows(table: readonly FlowDefinition[], canvas: FlowCanvas): CanvasFlows {
  const defs = new Map(table.map((d) => [d.type, d]));
  const nodes = new Map((canvas.nodes ?? []).map((n) => [n.name, n]));
  const edges = (canvas.edges ?? []).filter((e) => nodes.has(e.from) && nodes.has(e.to));
  const into = new Map<string, FlowEdge[]>([...nodes.keys()].map((n) => [n, []]));
  for (const e of edges) into.get(e.to)?.push(e);

  const order: string[] = [];
  const left = new Map([...nodes.keys()].map((n) => [n, into.get(n)?.length ?? 0]));
  const ready = [...left].filter(([, k]) => k === 0).map(([n]) => n);
  while (ready.length) {
    const n = ready.shift();
    if (n === undefined) break;
    order.push(n);
    for (const e of edges) if (e.from === n) {
      const remaining = (left.get(e.to) ?? 0) - 1;
      left.set(e.to, remaining);
      if (remaining === 0) ready.push(e.to);
    }
  }
  for (const n of nodes.keys()) if (!order.includes(n)) order.push(n);

  const out = new Map<string, Flow>();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const name of order) {
      const node = nodes.get(name);
      if (!node) continue;
      const feed = (into.get(name) ?? []).map((e) => out.get(e.from)).filter((flow) => flow !== undefined);
      out.set(name, through(defs.get(node.type), node, join(feed)));
    }
  }
  const edgeFlows = new Map<string, Flow>();
  for (const edge of edges) {
    const flow = out.get(edge.from);
    if (flow) edgeFlows.set(edgeKey(edge), flow);
  }
  return { out, edges: edgeFlows };
}

/* 印成一行:「Text · 按文件」。不知道的那一半就不印,不写「未知」占位。 */
const per = (p: Flow["per"]): string => (Array.isArray(p) ? p.map((u) => `按${u}`).join(" / ") : p ? `按${p}` : "");
const head = (h: Flow["head"]): string => (Array.isArray(h) ? h.join(" / ") : h ?? "");
export const label = (flow?: Flow | null): string => (flow ? [head(flow.head), per(flow.per)].filter(Boolean).join(" · ") : "");
