import { fullCard, miniCard } from "./card.mjs";
import { layout, wire, wireLabelAt, TILE } from "./layout.mjs";

const world = document.getElementById("world");
const wires = document.getElementById("wires");
const viewport = document.getElementById("viewport");

const [table, canvas] = await Promise.all([
  fetch("/api/node-table").then((r) => r.json()),
  fetch(`/api/canvas${location.search}`).then((r) => r.json()),
]);
const byType = new Map(table.map((d) => [d.type, d]));

document.getElementById("task").textContent = canvas.task ?? "";
document.getElementById("sub").textContent =
  `画布 v${canvas.version} · ${canvas.nodes.length} 个节点 · ${canvas.edges.length} 条线`;

const placed = layout(canvas.nodes, canvas.edges);
const at = new Map(placed.map((p) => [p.node.name, p]));

for (const p of placed) {
  const def = byType.get(p.node.type);
  if (!def) continue;
  const el = document.createElement("div");
  el.className = "node";
  el.style.cssText = `left:${p.x}px;top:${p.y}px;--c:${def.color}`;
  el.innerHTML = `<div class="card">${miniCard(def, p.node)}${fullCard(def, p.node, canvas.edges)}</div>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = el.classList.contains("open");
    document.querySelectorAll(".node.open").forEach((n) => n.classList.remove("open"));
    if (!open) el.classList.add("open");
  });
  world.appendChild(el);
}
const wanted = new URL(location.href).searchParams.get("open");
if (wanted) document.querySelectorAll(".node").forEach((n) => {
  if (n.querySelector(".mini-name")?.textContent === wanted) n.classList.add("open");
});

document.addEventListener("click", () => {
  document.querySelectorAll(".node.open").forEach((n) => n.classList.remove("open"));
});

/* 线画在卡底下,出口名(True / False)贴在线上。 */
const svgns = "http://www.w3.org/2000/svg";
for (const e of canvas.edges) {
  const from = at.get(e.from);
  const to = at.get(e.to);
  if (!from || !to) continue;
  const w = wire(from, to);
  const path = document.createElementNS(svgns, "path");
  path.setAttribute("class", "wire");
  path.setAttribute("d", w.d);
  wires.appendChild(path);
  const head = document.createElementNS(svgns, "path");
  head.setAttribute("class", "arrow");
  head.setAttribute("d", `M ${w.x1 - 9} ${w.y1 - 5} L ${w.x1} ${w.y1} L ${w.x1 - 9} ${w.y1 + 5} Z`);
  wires.appendChild(head);
  if (e.output) {
    const at_ = wireLabelAt(w);
    const text = document.createElementNS(svgns, "text");
    text.setAttribute("class", "port-label");
    text.setAttribute("x", at_.x);
    text.setAttribute("y", at_.y - 8);
    text.setAttribute("text-anchor", "middle");
    text.textContent = e.output === "true" ? "True" : "False";
    wires.appendChild(text);
  }
}

/* 镜头:一开始把整张图放进窗口,之后滚轮缩放、拖动平移。 */
const box = {
  w: Math.max(...placed.map((p) => p.x)) + TILE,
  h: Math.max(...placed.map((p) => p.y)) + TILE,
};
wires.setAttribute("width", box.w);
wires.setAttribute("height", box.h);
const pad = 90;
let scale = Math.min(1, (innerWidth - pad * 2) / box.w, (innerHeight - pad * 2) / box.h);
let tx = (innerWidth - box.w * scale) / 2;
let ty = (innerHeight - box.h * scale) / 2;
const apply = () => (world.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`);
const focus = wanted && at.get(wanted);
if (focus) {
  tx = innerWidth / 2 - (focus.x + TILE / 2) * scale;
  ty = innerHeight / 2 - (focus.y + TILE / 2) * scale;
}
apply();

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  const k = Math.exp(-e.deltaY / 420);
  const next = Math.min(1.6, Math.max(0.2, scale * k));
  tx = e.clientX - (e.clientX - tx) * (next / scale);
  ty = e.clientY - (e.clientY - ty) * (next / scale);
  scale = next;
  apply();
}, { passive: false });

/* 拖动:按下先不抢指针,挪过 4 像素才算拖,否则那一下是点在卡片上。 */
let drag = null;
viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".node")) return;
  drag = { x: e.clientX - tx, y: e.clientY - ty, from: [e.clientX, e.clientY], moved: false };
});
viewport.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.from[0], e.clientY - drag.from[1]) < 4) return;
    drag.moved = true;
    viewport.classList.add("grabbing");
    viewport.setPointerCapture(e.pointerId);
  }
  tx = e.clientX - drag.x;
  ty = e.clientY - drag.y;
  apply();
});
viewport.addEventListener("pointerup", (e) => {
  if (drag?.moved) viewport.releasePointerCapture(e.pointerId);
  drag = null;
  viewport.classList.remove("grabbing");
});
