import { createCanvasView } from "./canvas.mjs";
import { createPlanCard } from "./plan-card.mjs";

const $ = (id) => document.getElementById(id);
const table = await fetch("/api/node-table").then((r) => r.json());

const view = createCanvasView({
  table, world: $("world"), wires: $("wires"), viewport: $("viewport"),
  /* 右上角的需求框占掉一条,卡片不能钻到它下面。 */
  insets: () => ({
    right: card.isMini ? 360 : 0,
    bottom: innerHeight - document.querySelector(".bar").getBoundingClientRect().top + 24,
  }),
});
const card = createPlanCard({ card: $("plan"), stage: $("stage") });

const post = (path, data) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data ?? {}) })
    .then((r) => r.json());

let plan = null;
let busy = null;
const done = new Set();

/* 输入框的提示按阶段换:没方案时说要什么,有待确认时先答它,答完了就是改。 */
function placeholder() {
  const el = $("input");
  if (!plan) el.placeholder = "描述你要做的数据处理";
  else if (plan.openQuestions.length) el.placeholder = "回答上面待确认的问题";
  else el.placeholder = "还想改点什么";
}

/* 轨道上那一行字:当下这一步的名字;后面还剩几步决定线有多长。 */
const waitingOn = (refs) => ({
  title: refs.map((ref) => plan?.steps.find((s) => s.ref === ref)?.title ?? ref).join("、"),
  remaining: plan ? plan.steps.filter((s) => !done.has(s.ref)).length : refs.length,
});

const canSend = () => $("input").value.trim() !== "" && !busy;
const refreshSend = () => ($("send").disabled = !canSend());

async function send() {
  if (!canSend()) return;
  const text = $("input").value.trim();
  $("input").value = "";
  refreshSend();
  if (card.isMini) await card.toCenter();
  card.ask(text);
  const r = await post("/api/say", { text });
  if (r.error) card.status(r.error);
}

/* 发送:按钮和回车都行。中文输入法确认候选词的那一下回车不算发送。 */
$("input").addEventListener("input", refreshSend);
$("input").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  send();
});
$("form").addEventListener("submit", (e) => { e.preventDefault(); send(); });

/* 卡片飞走或飞回来,右边空出来的那一条变了,镜头跟着重新放一次。 */
card.onGo(async () => {
  done.clear();
  const r = await post("/api/start");
  if (r.error) return card.status(r.error);
  await card.toMini("正在生成");
  view.fit();
});
card.onClose(async () => { await card.back(); view.fit(); });
$("plan").addEventListener("click", async () => {
  if (!card.isMini) return;
  await card.toCenter();
  view.fit();
});

/* ?still 只看现在这一眼,不挂长连接——截图工具等不到一个不断线的页面。 */
const still = new URLSearchParams(location.search).has("still");
const feed = still ? {} : new EventSource("/api/events");
feed.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if (event.type === "thinking") { busy = event.who; refreshSend(); }
  /* 这一波要做哪几步,写到画布上——等着的人得知道当下在做什么。 */
  if (event.type === "wave") view.waiting(waitingOn(event.refs));
  if (event.type === "plan") {
    busy = null;
    plan = event.plan;
    refreshSend();
    placeholder();
    card.show(event);
  }
  if (event.type === "step") {
    done.add(event.step.ref);
    view.draw(event.canvas);
    card.status(`正在生成 · ${done.size} / ${plan?.steps.length ?? done.size}`);
  }
  if (event.type === "run") {
    busy = null;
    refreshSend();
    view.waiting(null);
    view.draw(event.canvas);
    const run = event.run;
    const bad = run.steps.find((s) => s.outcome === "rejected" || s.outcome === "failed");
    card.status(bad ? `停在 ${bad.ref}` : `已生成 ${event.canvas.nodes.length} 个节点`);
    /* 断了就把断口留在画布上,不弹东西。 */
    if (bad) view.waiting({ title: bad.reasons ? bad.reasons[0] : bad.error, remaining: 0, broken: true });
  }
  if (event.type === "error") { busy = null; refreshSend(); view.waiting(null); card.status(event.message); }
};

const state = await fetch("/api/state").then((r) => r.json());
plan = state.plan;
placeholder();
/* 生成到一半刷新页面,状态不能丢:还在跑就把那一格重新摆回画布上。 */
if (state.turn === "executor" && state.wave) {
  card.restore(state, "正在生成");
  view.waiting(waitingOn(state.wave));
  view.draw(state.canvas);
  view.fit();
} else if (state.canvas.nodes.length) {
  card.restore(state, `已生成 ${state.canvas.nodes.length} 个节点`);
  view.draw(state.canvas);
  view.fit();
} else if (state.task) {
  card.ask(state.task);
  await card.show(state);
}
if (!state.hasExecutor) card.status("执行者未接入:启动时设置 EXECUTOR_MODULE。");
addEventListener("resize", () => { view.fit(); card.reflow(); });
