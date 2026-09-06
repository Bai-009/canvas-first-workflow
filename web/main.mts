import type { PlanProposal, Canvas, CanvasNode } from '../shared/contracts.mjs';
import type { Run, Edit, Turn } from '../shared/workflow.mjs';
import type { Snapshot, TransportEvent } from '../shared/http.mjs';
import { isRecord } from '../shared/json.mjs';
import { errorMessage } from '../shared/errors.mjs';
import { readCanvas, readEvent, readNodeTable, readSnapshot } from './readers.mjs';
import { element } from './dom.mjs';
import { createCanvasView } from "./canvas.mjs";
import { createPlanCard } from "./plan-card.mjs";
import { isEditing } from "./node-conversation.mjs";
import { createEventCursor } from "./event-cursor.mjs";
import { chooseSession, createSessionSidebar, readLocal, writeLocal, draftKey } from "./sessions.mjs";

const ui = {
  "bar-status": element<HTMLElement>(document, "#bar-status"),
  "form": element<HTMLFormElement>(document, "#form"),
  "grow": element<HTMLElement>(document, "#grow"),
  "input": element<HTMLTextAreaElement>(document, "#input"),
  "picker": element<HTMLElement>(document, "#picker"),
  "plan": element<HTMLElement>(document, "#plan"),
  "plan-problems": element<HTMLElement>(document, "#plan-problems"),
  "send": element<HTMLButtonElement>(document, "#send"),
  "stage": element<HTMLElement>(document, "#stage"),
  "viewport": element<HTMLElement>(document, "#viewport"),
  "wires": element<SVGSVGElement>(document, "#wires"),
  "world": element<HTMLElement>(document, "#world"),
  "zoom-fit": element<HTMLButtonElement>(document, "#zoom-fit"),
  "zoom-in": element<HTMLButtonElement>(document, "#zoom-in"),
  "zoom-out": element<HTMLButtonElement>(document, "#zoom-out"),
  "zoom-reset": element<HTMLButtonElement>(document, "#zoom-reset"),
};
const $ = <K extends keyof typeof ui>(id: K) => ui[id];
const { id: sessionId, listing } = await chooseSession();
const sessionPath = (path: string) => path.replace("/api/", `/api/sessions/${sessionId}/`);
let savedDrafts: unknown;
try { savedDrafts = JSON.parse(readLocal(draftKey(sessionId), "{}")); } catch { savedDrafts = {}; }
const rawDrafts = isRecord(savedDrafts) ? savedDrafts : {};
const drafts = { ...rawDrafts, global: typeof rawDrafts.global === "string" ? rawDrafts.global : "",
  nodes: Object.fromEntries(Object.entries(isRecord(rawDrafts.nodes) ? rawDrafts.nodes : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
const saveDrafts = () => writeLocal(draftKey(sessionId), JSON.stringify(drafts));
const sidebar = createSessionSidebar({ id: sessionId, listing, onRetrySave: () => post("/api/save"), onResize: () => { view.refit(); card.reflow(); } });
const table = readNodeTable(await fetch("/api/node-table").then((r) => r.json()));
const view = createCanvasView({
  table, world: $("world"), wires: $("wires"), viewport: $("viewport"),
  stage: $("stage"), picker: $("picker"), onRevise: revise, onStopRevision: stopRevision, onFill: configure,
  onZoom: (scale) => {
    $("zoom-reset").textContent = `${Math.round(scale * 100)}%`;
    $("zoom-out").disabled = scale <= 0.2;
    $("zoom-in").disabled = scale >= 1.6;
  },
  nodeDraft: (node) => drafts.nodes?.[JSON.stringify([node.step, node.name])] ?? "",
  onNodeDraft: (node, value) => { drafts.nodes ??= {}; drafts.nodes[JSON.stringify([node.step, node.name])] = value; saveDrafts(); },
  insets: () => ({
    left: sidebar.left(),
    right: card.isMini && innerWidth - sidebar.left() > 1000 ? 360 : 0,
    bottom: innerHeight - element(document, ".bar").getBoundingClientRect().top + 24,
  }),
});
const card = createPlanCard({ card: $("plan"), stage: $("stage"), leftInset: () => sidebar.left() });
$("zoom-out").addEventListener("click", () => view.zoomBy(-1));
$("zoom-in").addEventListener("click", () => view.zoomBy(1));
$("zoom-reset").addEventListener("click", () => view.resetZoom());
$("zoom-fit").addEventListener("click", () => view.fitAll());
new ResizeObserver(([entry]) => {
  if (!entry) return;
  document.body.style.setProperty("--composer-height", `${entry.target.getBoundingClientRect().height}px`);
}).observe(element(document, ".bar"));

async function post(path: string, data?: unknown) {
  let response;
  try { response = await fetch(sessionPath(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data ?? {}) }); }
  catch { throw new Error("连接中断，文字已保留。请检查连接后重试。"); }
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error("服务未能完成这次请求，文字已保留，请重试。"); }
  if (!isRecord(result)) throw new Error("服务响应格式不正确，文字已保留，请重试。");
  if (!response.ok || result.error) throw new Error(typeof result.error === "string" ? result.error : "这次请求未被接受，请重试。");
  return result;
}

let plan: PlanProposal | null = null, revision = 0, busy: Exclude<Turn, "user"> | "configuration" | null = null, broke: ReturnType<typeof stopAt> = null, started = false;
let canvas: Canvas = { nodes: [], edges: [], version: 0 }, edits: Edit[] = [], hasReviser = false;
let canvasPlanRevision: number | null = null, lastRun: Run | null = null, globalError = "", storageError = "", recoveryNotice = "";
const done = new Set<string>();
const titleOf = (ref: string): string => plan?.steps.find((s) => s.ref === ref)?.title ?? ref;
const named = (text: unknown) => String(text ?? "").replace(/\bs\d+\b/g, (ref) => titleOf(ref));
function stopAt(run: Run | null) {
  if (!run || run.endedBy === "finished") return null;
  const last = run.steps.at(-1);
  if (!last || last.outcome === "done" || last.outcome === "covered") return null;
  const whys = last.reasons ?? (last.error ? [last.error] : last.outcome === "stopped" ? ["按了停"] : []);
  return { ref: last.ref, why: whys.map(named).join("\n") };
}
const canReset = () => {};
function status(text: string) {
  card.status(text);
  if (!card.isMini) element($("plan"), ".plan-say").textContent = text;
}
function placeholder() {
  const input = $("input");
  input.placeholder = !plan ? "描述你要做的数据处理" : plan.openQuestions.length ? "回答方案里的待确认问题，或说明整体调整" : "告诉方案设计者，整体还想怎么调整";
  input.setAttribute("aria-label", "与方案设计者讨论整体工作流");
}
function showBreak() {
  placeholder();
  if (broke) view.waiting({ title: titleOf(broke.ref), note: broke.why, remaining: 0, broken: true });
}
const waitingOn = (refs: string[]) => ({
  title: refs.map(titleOf).join("、"),
  remaining: plan ? plan.steps.filter((s) => !done.has(s.ref)).length : refs.length,
});
function revisionBlocked() {
  if (lastRun?.problems?.length) return `当前画布未通过完整检查：${lastRun.problems.map(named).join("；")}。请打开右上方案，检查后重新生成。`;
  if (!hasReviser) return "工作流修改尚未接入，暂时不能发送。";
  if (!canvas.nodes.length || lastRun?.endedBy !== "finished") return "先完成工作流构建，再从节点提出修改。";
  if (canvasPlanRevision !== revision) return "方案有新变化；先应用方案并完成构建，再修改节点。";
  return "";
}
const canSend = () => $("input").value.trim() !== "" && !busy;
function refresh() {
  $("send").disabled = !canSend();
  $("send").title = busy ? "等待当前工作流操作完成；可以继续写草稿" : "发送给方案设计者";
  const go = element<HTMLButtonElement>($("plan"), ".plan-go");
  go.disabled = Boolean(busy);
  go.title = busy ? "等待当前操作完成后生成" : "应用当前方案并生成工作流";
  $("bar-status").textContent = storageError || globalError || recoveryNotice || "";
  const problems = $("plan-problems");
  const text = busy === "executor" ? "" : (lastRun?.problems ?? []).map(named).join("\n");
  problems.hidden = !text;
  if (problems.textContent !== text) problems.textContent = text;
  element($("plan"), ".plan-dot").classList.toggle("has-problems", Boolean(text));
  view.revisions({ edits, busy: Boolean(busy), blockedReason: revisionBlocked() });
}
const grow = () => { $("grow").dataset.value = $("input").value; };

async function send() {
  if (!canSend()) return;
  const draft = $("input").value, text = draft.trim();
  busy = "plan"; globalError = ""; refresh();
  if (card.isMini) await card.toCenter();
  started = true; canReset(); card.ask(text);
  try {
    await post("/api/say", { text });
    if ($("input").value === draft) { $("input").value = ""; drafts.global = ""; saveDrafts(); grow(); }
  } catch (error) { busy = null; globalError = errorMessage(error); status(errorMessage(error)); }
  refresh();
}

async function revise({ node, text }: { node: CanvasNode; text: string }) {
  if (busy) throw new Error("工作流正在处理，文字已保留，稍后可发送。");
  const blocked = revisionBlocked();
  if (blocked) throw new Error(blocked);
  const current = canvas.nodes.find((n) => n.name === node.name && n.step === node.step);
  if (!current) throw new Error("这个节点已经变化，请查看当前工作流后再发送。");
  busy = "revision"; globalError = ""; refresh();
  status("正在结合整条工作流修改");
  try { await post("/api/revise", { node: current.name, step: current.step, canvasVersion: canvas.version, text }); }
  catch (error) { busy = null; status("修改未开始，文字已保留"); refresh(); throw error; }
}
async function configure({ node, key, value }: { node: string; key: string; value: unknown }) {
  if (busy) throw new Error("工作流正在处理，请稍后保存参数。");
  busy = "configuration"; $("send").disabled = true;
  try {
    const result = await post("/api/configure", { node, key, value, canvasVersion: canvas.version });
    canvas = readCanvas(result.canvas); view.draw(canvas, { instant: true });
  } finally { busy = null; refresh(); }
}
async function stopRevision() { await post("/api/stop"); }

async function startRun() {
  if (busy) return;
  const previousBreak = broke;
  broke = null; done.clear(); view.waiting(null); placeholder();
  busy = "executor"; globalError = ""; refresh();
  try {
    await post("/api/start");
    if (!card.isMini) await card.toMini("正在生成");
    if (busy === "executor") status("正在生成");
    else status(canvasStatus());
    view.fit();
  } catch (error) { busy = null; broke = previousBreak; globalError = errorMessage(error); status(errorMessage(error)); showBreak(); refresh(); }
}
$("input").addEventListener("input", () => { drafts.global = $("input").value; saveDrafts(); globalError = ""; grow(); refresh(); });
$("input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  e.preventDefault(); send();
});
$("form").addEventListener("submit", (e) => { e.preventDefault(); send(); });
card.onGo(startRun);
card.onClose(async () => { await card.back(); placeholder(); });
view.onBreak({
  rerun: startRun,
  plan: async () => {
    if (busy) return;
    busy = "plan"; globalError = ""; refresh();
    try { await post("/api/escalate"); }
    catch (error) { busy = null; globalError = errorMessage(error); status(errorMessage(error)); refresh(); }
  },
});
$("plan").addEventListener("click", async () => {
  if (!card.isMini) return;
  await card.toCenter(); placeholder(); refresh();
});
addEventListener("click", async (e) => {
  if (!(e.target instanceof Element)) return;
  if (card.isMini || e.target.closest(".plan") || e.target.closest(".picker") || e.target.closest(".sessions") || e.target.closest("dialog") || e.target.closest(".top")) return;
  if (e.target.closest(".bar") || element($("plan"), ".plan-close").hidden) return;
  await card.back(); placeholder();
});

const editTitles: Partial<Record<Edit["status"], string>> = { applied: "工作流已修改", unchanged: "无需修改，画布保持原样", failed: "修改未完成，画布保持原样", stopped: "已停止修改", needs_plan: "需要完善整体方案" };
async function eventReceived(event: TransportEvent) {
  if (event.type === "sessions") return sidebar.update(event);
  if (event.storageError !== undefined) storageError = event.storageError;
  if (event.notice !== undefined) recoveryNotice = event.notice;
  if (event.savedAt || storageError) sidebar.saved(storageError ? "保存失败" : "已保存到本机", Boolean(storageError));
  if (event.type === "deleted") {
    const url = new URL(location.href); url.searchParams.delete("session"); location.assign(url); return;
  }
  if (event.type === "configured") { canvas = event.canvas; view.draw(canvas, { instant: true }); }
  if (event.type === "reset") return location.reload();
  if (event.type === "snapshot") return restoreSnapshot(event.state);
  if (event.type === "said") {
    if (card.isMini) await card.toCenter();
    started = true; canReset(); placeholder(); card.ask(event.text); return;
  }
  if (event.type === "draft") return card.draft(event);
  if (event.type === "thinking") { busy = event.who; globalError = ""; }
  if (event.type === "wave") view.waiting(waitingOn(event.refs));
  if (event.type === "plan") {
    busy = null; plan = event.plan ?? plan; revision = event.revision ?? revision;
    if (Object.hasOwn(event, "canvasPlanRevision")) canvasPlanRevision = event.canvasPlanRevision;
    placeholder(); await card.show({ ...event, plan });
  }
  if (event.type === "step") {
    done.add(event.step.ref); canvas = event.canvas; view.draw(canvas);
    status(`正在生成 · ${done.size} / ${plan?.steps.length ?? done.size}`);
  }
  if (event.type === "run") {
    busy = null; canvas = event.canvas; lastRun = event.run;
    canvasPlanRevision = event.canvasPlanRevision ?? null;
    view.draw(canvas); view.waiting(null); broke = stopAt(event.run);
    view.onIdle(() => { status(canvasStatus()); showBreak(); });
  }
  if (event.type === "edit") {
    edits = event.edits ?? [...edits.filter((e) => e.id !== event.edit.id), event.edit];
    const editing = isEditing(event.edit);
    busy = event.turn && event.turn !== "user" ? event.turn : editing ? "revision" : null;
    if (!editing && event.canvas) {
      canvas = event.canvas;
      if (["applied", "unchanged"].includes(event.edit.status)) canvasPlanRevision = event.edit.planRevision;
      view.draw(canvas, { instant: true });
    }
    const title = editing ? "正在结合整条工作流修改" : (editTitles[event.edit.status] ?? event.edit.summary);
    status(title);
  }
  if (event.type === "error") { busy = null; globalError = event.message; view.waiting(null); status(event.message); }
  refresh();
}

const still = new URLSearchParams(location.search).has("still");
const feed = still ? null : new EventSource(sessionPath("/api/events"));
let initialising = true, buffered: TransportEvent[] = [], chain = Promise.resolve();
let cursor: ReturnType<typeof createEventCursor>;
const queueEvent = (event: TransportEvent) => {
  chain = chain.then(async () => {
    if (!cursor.accept(event)) return;
    await eventReceived(event);
  }).catch((error) => { busy = null; globalError = errorMessage(error); refresh(); });
};
if (feed) feed.onmessage = (e) => {
  try { const event = readEvent(JSON.parse(String(e.data))); if (initialising) buffered.push(event); else queueEvent(event); }
  catch (error) { globalError = errorMessage(error); refresh(); }
};
addEventListener("pagehide", () => feed?.close());
if (feed) feed.onerror = () => { sidebar.saved("连接中断"); globalError = "连接暂时中断，正在重新连接；草稿已保留。"; refresh(); };

function canvasStatus() {
  if (busy === "revision") return "正在结合整条工作流修改";
  if (busy === "executor") return "正在生成";
  if (lastRun?.problems?.length) return `构建还需处理 ${lastRun.problems.length} 处问题`;
  return broke ? `停在 ${titleOf(broke.ref)}` : `已生成 ${canvas.nodes.length} 个节点`;
}
async function restoreSnapshot(state: Snapshot, { initial = false } = {}) {
  sidebar.update(state);
  plan = state.plan; revision = state.revision ?? 0; canvas = state.canvas;
  edits = state.edits ?? []; hasReviser = Boolean(state.hasReviser); lastRun = state.run;
  canvasPlanRevision = state.canvasPlanRevision ?? null;
  busy = state.turn && state.turn !== "user" ? state.turn : null;
  globalError = ""; storageError = state.storageError || ""; recoveryNotice = state.notice || "";
  sidebar.saved(storageError ? "保存失败" : "已保存到本机", Boolean(storageError));
  started = Boolean(state.task || plan || canvas.nodes.length); canReset(); placeholder();
  broke = stopAt(state.run);
  if (canvas.nodes.length || broke || state.turn === "executor") {
    if (initial) card.restore(state, canvasStatus());
    else await card.show(state);
    if (state.turn === "executor" && state.wave) {
      done.clear(); for (const n of canvas.nodes) done.add(n.step);
      view.waiting(waitingOn(state.wave));
    } else { view.waiting(null); showBreak(); }
    view.draw(canvas, { instant: true });
    status(canvasStatus());
  } else if (state.task) {
    if (initial) card.ask(state.task);
    await card.show(state);
  }
  if (!state.hasExecutor) status("执行者未接入：暂时不能生成工作流。");
  refresh();
}
const state = readSnapshot(await fetch(sessionPath("/api/state")).then((r) => r.json()));
$("input").value = drafts.global || $("input").value;
try { const boot = sessionStorage.getItem("canvasflow:boot-draft"); if (boot) { $("input").value = boot; drafts.global = boot; saveDrafts(); sessionStorage.removeItem("canvasflow:boot-draft"); } } catch {}
grow();
cursor = createEventCursor(state);
await restoreSnapshot(state, { initial: true });
initialising = false;
for (const event of buffered) queueEvent(event);
buffered = [];
addEventListener("resize", () => { view.fit(); card.reflow(); });
