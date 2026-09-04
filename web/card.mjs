import { icon, PLUS } from "./icons.mjs";

/* 一张卡完全由两样东西画出来:节点表里那一行(有哪些格、格叫什么、进出是什么类型)
   和画布上这个节点(叫什么名、填了什么、留空了哪几格、旁白写了什么)。
   前端不认得任何一种具体节点——加一个节点,这里一行不用改。 */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const BLOCK = new Set(["body", "conditions"]);

/* 一格印成什么:留空了就是一个可点的空位,填了就把填的印出来,
   没填也没留空就是节点表里的默认值。三种都印不出来的格,不占一行。

   三种都是可点的:空位是「这一格还没定」,填好的是「这一格定成了这样」,
   两种都是同一件事的两个状态,只让空的点得开,戏就做了一半。
   点开之后长什么样归 picker.mjs 管——这里只负责说清「这是哪一格」。 */
function fieldValue(slot, node) {
  const key = ` data-key="${esc(slot.key)}"`;
  if (node.blanks?.includes(slot.key)) {
    return `<button type="button" class="slot"${key}>${PLUS}${esc(slot.empty ?? `选${slot.label}`)}</button>`;
  }
  const filled = node.params?.[slot.key] ?? slot.default;
  if (filled === undefined || filled === "") return null;
  /* 填进来的不一定是一句话:Output Schema 这种格,AI 起草的是一份结构。
     卡上印它的字段清单——用户关心的是抽哪几样,不是那份 JSON 长什么样。 */
  if (filled !== null && typeof filled === "object") {
    const fields = Object.keys(filled.properties ?? filled);
    if (!fields.length) return null;
    return `<button type="button" class="set txt"${key}>${esc(fields.join("、"))}</button>`;
  }
  const cls = slot.kind === "number" || slot.kind === "text" ? "val" : "txt";
  return `<button type="button" class="set ${cls}"${key}>${esc(filled)}</button>`;
}

/* 进:上游节点的名字 + 节点表说的进什么类型;没有上游就是起点,印一横。
   出:分岔节点按出口一个一个印去哪儿,单出口的只印类型。 */
function io(def, node, edges) {
  const ins = edges.filter((e) => e.to === node.name);
  const inLine = def.input
    ? ins.length
      ? `${ins.map((e) => `<span class="name">${esc(e.from)}</span>`).join(" · ")} · ${esc(def.input)}`
      : esc(def.input)
    : "—";
  const outs = edges.filter((e) => e.from === node.name);
  let outLine = esc(def.output);
  if (def.ports) {
    const byPort = def.ports.map((p) => {
      const t = outs.filter((e) => e.output === p).map((e) => `<span class="name">${esc(e.to)}</span>`);
      return `${p[0].toUpperCase()}${p.slice(1)} → ${t.length ? t.join("、") : "—"}`;
    });
    outLine = byPort.join("<br>");
  }
  return `<div class="io"><b>Input</b><span>${inLine}</span><b>Output</b><span>${outLine}</span></div>`;
}

export function fullCard(def, node, edges) {
  const rows = [];
  const blocks = [];
  for (const slot of def.slots) {
    if (BLOCK.has(slot.kind) && !node.blanks?.includes(slot.key)) {
      const body = node.params?.[slot.key];
      if (body) blocks.push(`<div class="sec">${esc(slot.label)}</div>`
        + `<button type="button" class="prompt" data-key="${esc(slot.key)}">${esc(body)}</button>`);
      continue;
    }
    const value = fieldValue(slot, node);
    if (value) rows.push(`<div class="field"><span class="lbl">${esc(slot.label)}</span>${value}</div>`);
  }
  return [
    `<div class="full">`,
    `<div class="full-top"><span class="icon">${icon(def.type)}</span>`,
    `<h3 class="full-name">${esc(node.name)}</h3><span class="full-kind">${esc(def.kind)}</span></div>`,
    node.note ? `<p class="note">${esc(node.note)}</p>` : "",
    rows.length ? `<div class="fields">${rows.join("")}</div>` : "",
    blocks.join(""),
    io(def, node, edges),
    `</div>`,
  ].join("");
}

/* 收起来的样子:画布上多数时候看到的。右上角报状态,底下一行报还差几处。 */
export function miniCard(def, node) {
  const pending = node.blanks?.length ?? 0;
  const mark = pending ? `<span class="dot-c"></span>` : "✓";
  const evi = pending ? `<p class="mini-evi pending">待定 ${pending} 项</p>` : `<p class="mini-evi"></p>`;
  return [
    `<div class="mini">`,
    `<div class="mini-top"><span class="icon">${icon(def.type)}</span>`,
    `<span class="mini-kind">${esc(def.kind)}</span><span class="mark">${mark}</span></div>`,
    `<div class="mini-fill"></div>`,
    `<p class="mini-name">${esc(node.name)}</p>`,
    evi,
    `</div>`,
  ].join("");
}
