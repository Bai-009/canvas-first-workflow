import { createCanvasView } from "./canvas.mjs";

const $ = (id) => document.getElementById(id);
const table = await fetch("/api/node-table").then((r) => r.json());
const view = createCanvasView({
  table, world: $("world"), wires: $("wires"), viewport: $("viewport"),
  insets: () => ({
    right: $("plan").hidden ? 0 : innerWidth - $("plan").getBoundingClientRect().left + 18,
    bottom: innerHeight - $("status").getBoundingClientRect().top + 18,
  }),
});

const post = (path, data) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data ?? {}) })
    .then((r) => r.json());

let plan = null;
let busy = null;

function say(line) { $("status").textContent = line; }

function renderPlan(p, revision) {
  plan = p;
  if (!p) return;
  const open = p.openQuestions.length;
  $("plan").hidden = false;
  $("plan-head").textContent = `方案 v${revision} · ${p.steps.length} 步 · ${open ? `${open} 项待确认` : "待确认已清"}`;
  $("plan-goal").textContent = p.goal;
  $("plan-steps").innerHTML = p.steps
    .map((s) => `<li><b>${s.ref}</b>${s.title}</li>`).join("");
  $("plan-asks").innerHTML = open
    ? `<div class="asks-title">待确认</div>${p.openQuestions.map((q) => `<li>${q.question}</li>`).join("")}`
    : "";
  $("start").disabled = false;
}

function renderRun(run) {
  const bad = run.steps.find((s) => s.outcome === "rejected" || s.outcome === "failed");
  if (bad) return say(bad.reasons ? `没收,停在 ${bad.ref}:${bad.reasons.join(";")}` : `出错,停在 ${bad.ref}:${bad.error}`);
  if (run.endedBy !== "finished") return say("停了,轮到你");
  say(run.problems.length ? `跑完了。整张画布查了一遍,有问题:${run.problems.join(";")}` : "跑完了,线都接上了。轮到你。");
}

/* ?still 只看现在这一眼,不挂长连接——截图工具等不到一个不断线的页面。 */
const still = new URLSearchParams(location.search).has("still");
const feed = still ? { } : new EventSource("/api/events");
feed.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if (event.type === "thinking") {
    busy = event.who;
    say(event.who === "plan" ? "设计者在想…" : "执行者在搭…");
    $("start").disabled = true;
  }
  if (event.type === "plan") {
    busy = null;
    $("task").textContent = event.task;
    if (event.speech) $("speech").textContent = event.speech;
    renderPlan(event.plan, event.revision);
    say("方案在这儿。要改就再说一句,要搭就按开始。");
  }
  if (event.type === "step") {
    view.draw(event.canvas);
    const s = event.step;
    say(s.outcome === "done" ? `${s.ref} 做完 → ${s.nodes.join("、")}` : `${s.ref} ${s.outcome}`);
  }
  if (event.type === "run") {
    busy = null;
    view.draw(event.canvas);
    renderRun(event.run);
    $("start").disabled = false;
  }
  if (event.type === "error") { busy = null; say(event.message); $("start").disabled = false; }
};

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("input").value.trim();
  if (!text || busy) return;
  $("input").value = "";
  const r = await post("/api/say", { text });
  if (r.error) say(r.error);
});

$("start").addEventListener("click", async () => {
  if (busy) return;
  const r = await post("/api/start");
  if (r.error) say(r.error);
});

const state = await fetch("/api/state").then((r) => r.json());
$("task").textContent = state.task ?? "";
if (state.plan) renderPlan(state.plan, state.revision);
if (state.canvas.nodes.length) view.draw(state.canvas);
/* ?open=名字 直接把某张卡展开,给截图用。 */
const wanted = new URLSearchParams(location.search).get("open");
if (wanted) for (const el of document.querySelectorAll(".node")) {
  if (el.querySelector(".mini-name")?.textContent === wanted) el.classList.add("open");
}
say(state.hasExecutor ? "说一句你想让它做什么。" : "执行者的位置空着:启动时给 EXECUTOR_MODULE。");
addEventListener("resize", () => view.fit());
