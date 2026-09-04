/* 线上流的是什么。

   数据往下走,前面的东西都带着(架构.md「节点定义」):读文件加上文件,解析加上文本,
   向量化加上向量。所以一根线上流的不是「一种东西」,是上游一路加进来的全部;
   再加一样「按什么算一条」——每个文件一条、每块一条。

   这两样都从节点定义推,不猜:定义里写「要什么、加什么、按什么算一条」。
   浏览器印在线上,闸门拿它查接不接得上,状态机拿它比改前改后——三处一份代码,
   所以这个文件不引任何东西,浏览器和服务端都直接拿。 */

export const KINDS = ["Event", "File", "Text", "JSON", "Vector", "Result"];

export const edgeKey = (e) => `${e.from}>${e.to}>${e.output ?? ""}`;

/* 一个节点往流里加什么。定义里写死的直接用;写 slot:xxx 的(写代码那张)看这个节点
   自己填的格,没填就是不知道加了什么——不知道就印不知道,不替它编一个。 */
export function adds(def, node) {
  const a = def?.output?.adds;
  if (a === null || a === undefined) return null;
  if (a.startsWith("slot:")) {
    const v = node?.params?.[a.slice(5)];
    return KINDS.includes(v) ? v : null;
  }
  return a;
}

const EMPTY = { head: null, carries: [], per: null };
const uniq = (list) => [...new Set(list.flat().filter((x) => x !== null && x !== undefined))];
const one = (list) => (list.length === 0 ? null : list.length === 1 ? list[0] : list);

/* 几路汇进同一个节点:带着的东西合起来;单位不同就都留着,印的时候一起印,不挑一个。 */
export function join(list) {
  if (!list.length) return EMPTY;
  return {
    head: one(uniq(list.map((f) => f.head))),
    carries: uniq(list.map((f) => f.carries)),
    per: one(uniq(list.map((f) => f.per))),
  };
}

function through(def, node, into) {
  const a = adds(def, node);
  return {
    head: a ?? into.head,
    carries: a && !into.carries.includes(a) ? [...into.carries, a] : into.carries,
    per: def?.output?.per === "same" || !def?.output?.per ? into.per : def.output.per,
  };
}

/* 整张画布,每根线、每个节点出口上流的是什么。
   返回 { edges: Map(线的 key → flow), out: Map(节点名 → flow) },flow = { head, carries, per }:
   head 是最后加进来的那一样(线上印它),carries 是全部(闸门查它),per 是按什么算一条。
   先按上下游顺序走一遍;有环的那几个排在最后,再补一遍让它们也收敛。 */
export function flows(table, canvas) {
  const defs = new Map(table.map((d) => [d.type, d]));
  const nodes = new Map((canvas.nodes ?? []).map((n) => [n.name, n]));
  const edges = (canvas.edges ?? []).filter((e) => nodes.has(e.from) && nodes.has(e.to));
  const into = new Map([...nodes.keys()].map((n) => [n, []]));
  for (const e of edges) into.get(e.to).push(e);

  const order = [];
  const left = new Map([...nodes.keys()].map((n) => [n, into.get(n).length]));
  const ready = [...left].filter(([, k]) => k === 0).map(([n]) => n);
  while (ready.length) {
    const n = ready.shift();
    order.push(n);
    for (const e of edges) if (e.from === n && left.set(e.to, left.get(e.to) - 1).get(e.to) === 0) ready.push(e.to);
  }
  for (const n of nodes.keys()) if (!order.includes(n)) order.push(n);

  const out = new Map();
  for (let pass = 0; pass < 2; pass += 1) {
    for (const name of order) {
      const node = nodes.get(name);
      const feed = into.get(name).map((e) => out.get(e.from)).filter(Boolean);
      out.set(name, through(defs.get(node.type), node, join(feed)));
    }
  }
  return { out, edges: new Map(edges.map((e) => [edgeKey(e), out.get(e.from)])) };
}

/* 印成一行:「Text · 按文件」。不知道的那一半就不印,不写「未知」占位。 */
const per = (p) => (Array.isArray(p) ? p.map((u) => `按${u}`).join(" / ") : p ? `按${p}` : "");
const head = (h) => (Array.isArray(h) ? h.join(" / ") : h ?? "");
export const label = (flow) => (flow ? [head(flow.head), per(flow.per)].filter(Boolean).join(" · ") : "");
