import { createCanvasView } from "./canvas.mjs";
import { createPlanCard } from "./plan-card.mjs";

const $ = (id) => document.getElementById(id);
const table = await fetch("/api/node-table").then((r) => r.json());

const view = createCanvasView({
  table, world: $("world"), wires: $("wires"), viewport: $("viewport"),
  /* 右上角的需求框占掉一条,卡片不能钻到它下面。 */
  insets: () => ({
    right: card.isMini ? 360 : 0,
    bottom: innerHeight - $("status").getBoundingClientRect().top + 18,
  }),
});
const card = createPlanCard({ card: $("plan"), stage: $("stage") });

const post = (path, data) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data ?? {}) })
    .then((r) => r.json());

let plan = null;
let busy = null;
const say = (line) => ($("status").textContent = line);

/* 输入框的提示按阶段换:没方案时说要什么,有待确认时先答它,答完了就是改。 */
function placeholder() {
  const el = $("input");
  if (!plan) el.placeholder = "描述你要做的数据处理";
  else if (plan.openQuestions.length) el.placeholder = "回答上面待确认的问题";
  else el.placeholder = "还想改点什么";
}

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
  if (r.error) say(r.error);
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
  const r = await post("/api/start");
  if (r.error) return say(r.error);
  await card.toMini("正在搭");
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
  if (event.type === "plan") {
    busy = null;
    plan = event.plan;
    refreshSend();
    placeholder();
    card.show(event);
    say(event.plan ? "" : "没出方案,它先问了你几句。");
  }
  if (event.type === "step") {
    view.draw(event.canvas);
    const s = event.step;
    card.status(s.outcome === "done" ? `正在搭 · ${s.nodes.join("、")}` : `${s.ref} ${s.outcome}`);
  }
  if (event.type === "run") {
    busy = null;
    refreshSend();
    view.draw(event.canvas);
    const run = event.run;
    const bad = run.steps.find((s) => s.outcome === "rejected" || s.outcome === "failed");
    card.status(bad ? `停在 ${bad.ref}` : `已生成 ${event.canvas.nodes.length} 个节点`);
    say(bad
      ? (bad.reasons ? `没收,停在 ${bad.ref}:${bad.reasons.join(";")}` : `出错,停在 ${bad.ref}:${bad.error}`)
      : run.problems.length ? `整张画布查了一遍,有问题:${run.problems.join(";")}` : "");
  }
  if (event.type === "error") { busy = null; refreshSend(); say(event.message); }
};

const state = await fetch("/api/state").then((r) => r.json());
plan = state.plan;
placeholder();
if (state.canvas.nodes.length) {
  card.restore(state, `已生成 ${state.canvas.nodes.length} 个节点`);
  view.draw(state.canvas);
  view.fit();
} else if (state.task) {
  card.ask(state.task);
  await card.show(state);
}
if (!state.hasExecutor) say("执行者的位置空着:启动时给 EXECUTOR_MODULE。");
addEventListener("resize", () => { view.fit(); card.reflow(); });
