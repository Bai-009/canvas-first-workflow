import { PLUS } from "./icons.mjs";

/* 空位不是填空题,是入口。一个没定的参数要怎么补上,得看它是什么东西——
   形状由「人怎么给它」定,不由字段类型定。这四种来自 prototype/node-card.html:

     接数据源(source)   已连接的、上传文件、新建连接
     接连接(credential) 挑一个存好的凭据
     挑一个(pick)       选项本来就有限,直接给菜单;选项来自节点表
     真要打字(text/number/body/conditions)  只剩少数——一段正则、一句 SQL

   传文件(upload)是数据源面板里的那个动作单独拿出来用。 */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const I = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const BUCKET = I('<ellipse cx="12" cy="6.5" rx="7.5" ry="3"/><path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>');
const FOLDER = I('<path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
const TABLE = I('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9 9.5v10"/>');
const UP = I('<path d="M12 16V4.5M8 8l4-3.5L16 8"/><path d="M4.5 15v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>');
const KEY = I('<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H20M17 12v3M20 12v2.5"/>');
const DOT = I('<circle cx="12" cy="12" r="4"/>');

/* ⚠︎ 下面这几条是编的。POC 不接真实平台,画布上没有任何一处能去问「这里有哪些目录」。
   编出来的东西在面板底下都标着一行字,面上看得见,不靠读代码才知道。
   它们跟场景无关——模型每一趟生成的活儿都不一样,清单不能跟着场景编。 */
const 编的数据源 = [
  { v: "s3://data-lake/inbox/", icon: BUCKET, main: "data-lake / inbox", sub: "对象存储 · cn-shanghai", meta: "1,271 个文件" },
  { v: "/data/inbox", icon: FOLDER, main: "/data/inbox", sub: "本机目录", meta: "86 个文件" },
  { v: "public.documents", icon: TABLE, main: "public.documents", sub: "Postgres · 表", meta: "按行读" },
];
const 编的连接 = [
  { v: "data-warehouse", icon: KEY, main: "data-warehouse", sub: "Postgres · cn-shanghai", meta: "" },
  { v: "vector-store", icon: KEY, main: "vector-store", sub: "Milvus · cn-shanghai", meta: "" },
];
const 编的 = "这几条是编的，POC 不接真实平台。节点、参数、空位本身来自模型真正交回来的那一份。";

const row = (r) => `<button class="src-row" type="button" data-v="${esc(r.v)}">
  <span class="src-ico">${r.icon}</span>
  <span class="src-main"><b>${esc(r.main)}</b>${r.sub ? `<i>${esc(r.sub)}</i>` : ""}</span>
  ${r.meta ? `<span class="src-meta">${esc(r.meta)}</span>` : ""}
</button>`;

const drop = (text, icon, act) => `<button class="src-row drop" type="button" data-do="${act}">
  <span class="src-ico">${icon}</span><span class="src-main"><b>${esc(text)}</b></span></button>`;

/* 一格印成一张面板。返回面板正文;选中什么由 data-v 说,打字的走 .panel-field。 */
export function panel(def, slot, node) {
  const now = node.params?.[slot.key] ?? slot.default ?? "";
  const 待定 = node.blanks?.includes(slot.key);
  const top = `<div class="panel-top"><h4>${esc(slot.label)}</h4>
    <span class="why">${esc(node.name)}</span>
    <button class="panel-close" type="button">取消</button></div>`;

  if (slot.kind === "source" || slot.kind === "credential") {
    const 有的 = slot.kind === "source" ? 编的数据源 : 编的连接;
    const 动作 = slot.kind === "source"
      ? drop("上传文件", UP, "upload") + drop("新建连接", PLUS, "new")
      : drop("新建连接", PLUS, "new");
    return `${top}
      <p class="panel-sub">${esc(slot.kind === "source" ? "这一步要一个位置，数据从那儿来。" : "这一步要一个连接，凭据存在平台上。")}</p>
      <p class="panel-lbl">已连接</p>${有的.map(row).join("")}
      <div class="src-actions">${动作}</div>
      <p class="panel-note">${esc(编的)}</p>`;
  }

  if (slot.kind === "upload") {
    return `${top}
      <p class="panel-sub">这一格要一份文件。</p>
      <div class="src-actions">${drop("上传文件", UP, "upload")}</div>
      <p class="panel-note">POC 不收文件。</p>`;
  }

  if (slot.kind === "pick") {
    const 选项 = slot.options ?? [];
    return `${top}
      <p class="panel-sub">选项就这几个。</p>
      ${选项.map((o) => row({ v: o, icon: DOT, main: o, sub: "", meta: o === now ? "现在用的" : "" })).join("")}`;
  }

  /* 真要打字的:一段正则、一句 SQL、一大块 Prompt。大段的给一块,一行的给一行。 */
  const 大段 = slot.kind === "body" || slot.kind === "conditions";
  return `${top}
    <p class="panel-sub">${esc(大段 ? "这一格是一整段，写完按存下。" : "这一格是自己写的。")}</p>
    ${大段
      ? `<textarea class="panel-field" rows="9" spellcheck="false">${esc(待定 ? "" : now)}</textarea>`
      : `<input class="panel-field" type="${slot.kind === "number" ? "number" : "text"}" value="${esc(待定 ? "" : now)}" />`}
    <div class="src-actions"><button class="src-row drop" type="button" data-do="ok"><span class="src-main"><b>存下</b></span></button></div>`;
}
