import { createCanvasView } from "./canvas.mjs";
import { createPlanCard } from "./plan-card.mjs";
import { isEditing } from "./node-conversation.mjs";
import { createEventCursor } from "./event-cursor.mjs";
import { chooseSession, createSessionSidebar, readLocal, writeLocal, draftKey } from "./sessions.mjs";

const $ = (id) => document.getElementById(id);
const { id: sessionId, listing } = await chooseSession();
const sessionPath = (path) => path.replace("/api/", `/api/sessions/${sessionId}/`);
let drafts;
try { drafts = JSON.parse(readLocal(draftKey(sessionId), "{}")); } catch { drafts = {}; }
if (!drafts || typeof drafts !== "object" || Array.isArray(drafts)) drafts = {};
const saveDrafts = () => writeLocal(draftKey(sessionId), JSON.stringify(drafts));
const sidebar = createSessionSidebar({ id: sessionId, listing, onRetrySave: () => post("/api/save"), onResize: () => { view.refit(); card.reflow(); } });
const table = await fetch("/api/node-table").then((r) => r.json());
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
    bottom: innerHeight - document.querySelector(".bar").getBoundingClientRect().top + 24,
  }),
});
const card = createPlanCard({ card: $("plan"), stage: $("stage"), leftInset: () => sidebar.left() });
$("zoom-out").addEventListener("click", () => view.zoomBy(-1));
$("zoom-in").addEventListener("click", () => view.zoomBy(1));
$("zoom-reset").addEventListener("click", () => view.resetZoom());
$("zoom-fit").addEventListener("click", () => view.fitAll());
new ResizeObserver(([entry]) => {
  document.body.style.setProperty("--composer-height", `${entry.target.getBoundingClientRect().height}px`);
}).observe(document.querySelector(".bar"));

async function post(path, data) {
  let response;
  try { response = await fetch(sessionPath(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data ?? {}) }); }
  catch { throw new Error("连接中断，文字已保留。请检查连接后重试。"); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error("服务未能完成这次请求，文字已保留，请重试。"); }
  if (!response.ok || result.error) throw new Error(result.error || "这次请求未被接受，请重试。");
  return result;
}

let plan = null, revision = 0, busy = null, broke = null, started = false;
let canvas = { nodes: [], edges: [], version: 0 }, edits = [], hasReviser = false;
let canvasPlanRevision = null, lastRun = null, globalError = "", storageError = "", recoveryNotice = "";
const done = new Set();
const titleOf = (ref) => plan?.steps.find((s) => s.ref === ref)?.title ?? ref;
const named = (text) => String(text ?? "").replace(/\bs\d+\b/g, (ref) => titleOf(ref));
function stopAt(run) {
  if (!run || run.endedBy === "finished") return null;
  const last = run.steps.at(-1);
  if (!last || last.outcome === "done" || last.outcome === "covered") return null;
  const whys = last.reasons ?? (last.error ? [last.error] : last.outcome === "stopped" ? ["按了停"] : []);
  return { ref: last.ref, why: whys.map(named).join("\n") };
}
const canReset = () => {};
function status(text) {
  card.status(text);
  if (!card.isMini) $("plan").querySelector(".plan-say").textContent = text;
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
const waitingOn = (refs) => ({
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
  const go = $("plan").querySelector(".plan-go");
  go.disabled = Boolean(busy);
  go.title = busy ? "等待当前操作完成后生成" : "应用当前方案并生成工作流";
  $("bar-status").textContent = storageError || globalError || recoveryNotice || "";
  const problems = $("plan-problems");
  const text = busy === "executor" ? "" : (lastRun?.problems ?? []).map(named).join("\n");
  problems.hidden = !text;
  if (problems.textContent !== text) problems.textContent = text;
  $("plan").querySelector(".plan-dot").classList.toggle("has-problems", Boolean(text));
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
  } catch (error) { busy = null; globalError = error.message; status(error.message); }
  refresh();
}

async function revise({ node, text }) {
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
async function configure({ node, key, value }) {
  if (busy) throw new Error("工作流正在处理，请稍后保存参数。");
  busy = "configuration"; $("send").disabled = true;
  try {
    const result = await post("/api/configure", { node, key, value, canvasVersion: canvas.version });
    canvas = result.canvas; view.draw(canvas, { instant: true });
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
  } catch (error) { busy = null; broke = previousBreak; globalError = error.message; status(error.message); showBreak(); refresh(); }
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
    catch (error) { busy = null; globalError = error.message; status(error.message); refresh(); }
  },
});
$("plan").addEventListener("click", async () => {
  if (!card.isMini) return;
  await card.toCenter(); placeholder(); refresh();
});
addEventListener("click", async (e) => {
  if (card.isMini || e.target.closest(".plan") || e.target.closest(".picker") || e.target.closest(".sessions") || e.target.closest("dialog") || e.target.closest(".top")) return;
  if (e.target.closest(".bar") || $("plan").querySelector(".plan-close").hidden) return;
  await card.back(); placeholder();
});

async function eventReceived(event) {
  if (event.type === "sessions") return sidebar.update(event);
  if (Object.hasOwn(event, "storageError")) storageError = event.storageError;
  if (Object.hasOwn(event, "notice")) recoveryNotice = event.notice;
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
    const title = editing ? "正在结合整条工作流修改" : ({ applied: "工作流已修改", unchanged: "无需修改，画布保持原样", failed: "修改未完成，画布保持原样", stopped: "已停止修改", needs_plan: "需要完善整体方案" }[event.edit.status] ?? event.edit.summary);
    status(title);
  }
  if (event.type === "error") { busy = null; globalError = event.message; view.waiting(null); status(event.message); }
  refresh();
}

const still = new URLSearchParams(location.search).has("still");
const feed = still ? {} : new EventSource(sessionPath("/api/events"));
let initialising = true, buffered = [], chain = Promise.resolve(), cursor;
const queueEvent = (event) => {
  chain = chain.then(async () => {
    if (!cursor.accept(event)) return;
    await eventReceived(event);
  }).catch((error) => { busy = null; globalError = error.message; refresh(); });
};
feed.onmessage = (e) => { const event = JSON.parse(e.data); if (initialising) buffered.push(event); else queueEvent(event); };
addEventListener("pagehide", () => feed.close?.());
feed.onerror = () => { sidebar.saved("连接中断"); globalError = "连接暂时中断，正在重新连接；草稿已保留。"; refresh(); };

function canvasStatus() {
  if (busy === "revision") return "正在结合整条工作流修改";
  if (busy === "executor") return "正在生成";
  if (lastRun?.problems?.length) return `构建还需处理 ${lastRun.problems.length} 处问题`;
  return broke ? `停在 ${titleOf(broke.ref)}` : `已生成 ${canvas.nodes.length} 个节点`;
}
async function restoreSnapshot(state, { initial = false } = {}) {
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
const state = await fetch(sessionPath("/api/state")).then((r) => r.json());
$("input").value = drafts.global || $("input").value;
try { const boot = sessionStorage.getItem("canvasflow:boot-draft"); if (boot) { $("input").value = boot; drafts.global = boot; saveDrafts(); sessionStorage.removeItem("canvasflow:boot-draft"); } } catch {}
grow();
cursor = createEventCursor(state);
await restoreSnapshot(state, { initial: true });
initialising = false;
for (const event of buffered) queueEvent(event);
buffered = [];
addEventListener("resize", () => { view.fit(); card.reflow(); });
