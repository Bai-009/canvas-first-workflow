import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createSessionStore } from "../storage/session-store.mjs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeTable } from "../nodes/node-table.mjs";
import { createWorkflowSession, breakOf } from "../state-machine/workflow-session.mjs";
import { callerFromEnv, loadSystemPrompt } from "../plan/plan-agent.mjs";
import { projectRoot, resolveRuntimeModule } from "../runtime-paths.mjs";

/* 画布这一头的服务。命令行有什么,这里就有什么:说一句、按开始、批注、看画布。
   区别只在出口——命令行把事件打印成行,这里把同样的事件推给浏览器,
   于是执行者每交一步,画布上就长出一张卡。 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB = join(ROOT, "web");
const TYPE = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

const json = (res, data, code = 200) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const body = (req) => new Promise((done, fail) => {
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on("end", () => { try { done(raw ? JSON.parse(raw) : {}); } catch (e) { fail(e); } });
  req.on("error", fail);
});

/* 看客:每个打开的页面一条长连接,事件一来就推过去。 */
function createFeed() {
  const open = new Set();
  const id = randomUUID();
  let sequence = 0;
  return {
    id,
    get sequence() { return sequence; },
    join(res, state) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hi\n\n");
      res.write(`data: ${JSON.stringify({ type: "snapshot", state, sequence, feedId: id })}\n\n`);
      open.add(res);
      res.on("close", () => open.delete(res));
    },
    send(event) {
      const line = `data: ${JSON.stringify({ ...event, sequence: ++sequence, feedId: id })}\n\n`;
      for (const res of open) res.write(line);
    },
  };
}

/* 画布上按开始就是要真搭,所以执行者默认就是真的那个;
   要换成别的(比如测试用的固定答复)给 EXECUTOR_MODULE。 */
async function loadExecutor(env = process.env) {
  const which = env.EXECUTOR_MODULE ?? "src/executor/executor.mjs";
  if (which === "none") return null;
  const mod = await import(pathToFileURL(resolveRuntimeModule(which)).href);
  if (typeof mod.default !== "function") throw new Error(`${which} 没有默认导出一个函数`);
  return mod.default;
}

async function loadReviser(env = process.env) {
  const which = env.REVISER_MODULE ?? "src/executor/reviser.mjs";
  if (which === "none") return null;
  const mod = await import(pathToFileURL(resolveRuntimeModule(which)).href);
  if (typeof mod.default !== "function") throw new Error(`${which} 没有默认导出一个函数`);
  return mod.default;
}

/* 可注入的三个模型入口让 HTTP 与会话的边界能用固定答复验证。
   浏览器没有写入测试数据的专用接口，正常启动仍使用实际的 Agent。 */
export async function createWebServer({ callModel, executor: suppliedExecutor, reviser: suppliedReviser, systemPrompt,
  initialSession, initialPresentation = {}, storageDir = null, store: suppliedStore } = {}) {
  const table = nodeTable();
  const store = suppliedStore ?? createSessionStore(storageDir);
  const records = new Map();
  const executor = suppliedExecutor === undefined ? await loadExecutor() : suppliedExecutor;
  const reviser = suppliedReviser === undefined ? await loadReviser() : suppliedReviser;
  const planCaller = callModel ?? callerFromEnv();
  const newSession = (savedState) => createWorkflowSession({
    savedState,
    callModel: planCaller,
    executor, reviser,
    systemPrompt: systemPrompt ?? loadSystemPrompt(process.env.PLAN_PROMPT_LANG || "zh"),
  });
  const list = (trash = false) => [...records.values()].map((runtime) => runtime.summary())
    .filter((record) => Boolean(record.deletedAt) === trash).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const broadcastList = () => { const data = { sessions: list(), trash: list(true) }; for (const runtime of records.values()) runtime.notifyListing(data); };

  function runtimeFor(record, supplied) {
    const feed = createFeed();
    let session = supplied ?? newSession(record.workflow);
    let task = record.presentation?.task ?? "";
    let speech = record.presentation?.speech ?? "";
    let chat = structuredClone(record.presentation?.chat ?? []);
    let wave = null;
    let gen = 0;
    let storageError = "";
    let notice = record.workflow?.turn && record.workflow.turn !== "user"
      ? "服务曾中断，已恢复最后保存的工作流。未完成的操作没有自动重试。" : record.notice ?? "";
    const summary = () => ({ id: record.id, title: record.title || "新工作流", updatedAt: record.updatedAt,
      deletedAt: record.deletedAt ?? null, turn: session.turn, nodes: session.canvas.nodes.length, storageError });
    const save = () => {
      try {
        const next = { ...record, formatVersion: 1, workflow: session.exportState(),
          presentation: { task, speech, chat }, notice, updatedAt: new Date().toISOString() };
        store.save(next);
        Object.assign(record, next);
        storageError = "";
        return true;
      } catch (error) {
        storageError = `保存失败，当前内容仍在内存中，请重试保存后再关闭：${error.message}`;
        return false;
      }
    };
    const publish = (event) => {
      save();
      feed.send({ ...event, sessionId: record.id, savedAt: storageError ? null : record.updatedAt, storageError, notice });
      broadcastList();
    };

    const requireIdle = (res) => {
      if (storageError && !save()) { json(res, { error: storageError }, 503); return false; }
      if (session.turn === "user") return true;
      json(res, { error: "当前操作还在处理，请等它结束或先停止。", turn: session.turn }, 409);
      return false;
    };
    const requireCurrent = (res, receivedIn) => {
      if (receivedIn === gen) return true;
      json(res, { error: "工作流已新建，这条旧请求没有应用。", turn: session.turn }, 409);
      return false;
    };
    const snapshot = () => ({
      sessions: list(), trash: list(true), sessionId: record.id, title: record.title, savedAt: storageError ? null : record.updatedAt, storageError, notice,
      task, speech, chat, wave, canvas: session.canvas, plan: session.currentPlan, revision: session.revision,
      turn: session.turn, hasExecutor: session.hasExecutor, annotations: session.annotations,
      edits: session.edits, hasReviser: session.hasReviser, canvasPlanRevision: session.canvasPlanRevision,
      run: session.runs.at(-1) ?? null, sequence: feed.sequence, feedId: feed.id,
    });

    /* 一轮对话,不管是人打的还是画布替人说的:先喊「在想」,边写边推,写完整份推出去。 */
    const talk = async (run) => {
      const mine = gen;
      const running = session;
      const alive = () => mine === gen && running === session;
      notice = "";
      let turn;
      try {
        const pending = run({ onDraft: (draft) => alive() && feed.send({ type: "draft", task, chat, ...draft }) });
        publish({ type: "thinking", who: "plan" });
        turn = await pending;
      } catch (error) {
        if (alive()) publish({ type: "error", message: error.name === "AbortError" ? "已停止规划，当前方案保留。" : error.message, turn: running.turn });
        throw error;
      }
      if (!alive()) return;
      speech = turn.speech ?? "";
      if (speech) chat = [...chat, { who: "agent", text: speech }];
      publish({ type: "plan", task, chat, plan: running.currentPlan, diff: turn.diff,
        revision: turn.revision, canvasPlanRevision: running.canvasPlanRevision, speech });
    };

    const routes = {
      "GET /api/node-table": (_req, res) => json(res, table),
      "GET /api/events": (_req, res) => feed.join(res, snapshot()),
      "GET /api/state": (_req, res) => json(res, snapshot()),
      "POST /api/say": async (req, res, receivedIn) => {
        const { text } = await body(req);
        if (!requireCurrent(res, receivedIn)) return;
        if (typeof text !== "string" || !text.trim()) return json(res, { error: "说了空话" }, 400);
        if (!requireIdle(res)) return;
        if (!task) { task = text.trim(); if (!record.renamed) record.title = task.slice(0, 40); }
        chat = [...chat, { who: "user", text: text.trim() }];
        /* 边写边看:模型还在写的时候,把手上这半份推给页面。
           这一轮它的话还在写,所以草稿单独走 speech,不进 chat。 */
        await talk((options) => session.say(text.trim(), options));
        return json(res, { ok: true });
      },
      /* 断口交给设计者:话是状态机替人写的(停在哪儿、退了什么),先推给页面上墙,再走同一条对话的路。 */
      "POST /api/escalate": async (_req, res) => {
        if (!requireIdle(res)) return;
        if (!breakOf(session.runs.at(-1), session.currentPlan)) return json(res, { error: "没有停住的那一步" }, 400);
        const mine = gen;
        try {
          await talk((options) => session.escalate({
            ...options,
            onSaid: (said) => { if (mine !== gen) return; chat = [...chat, { who: "user", text: said }]; publish({ type: "said", text: said }); },
          }));
        } catch (error) {
          return json(res, { error: error.message }, 400);
        }
        return json(res, { ok: true });
      },
      /* 新开一条:上一条正在跑的先叫停,它后面再交回来的东西不算数。 */
      "POST /api/reset": (_req, res) => {
        session.stop();
        gen += 1;
        session = newSession();
        task = "";
        speech = "";
        chat = [];
        wave = null;
        publish({ type: "reset" });
        return json(res, { ok: true });
      },
      "POST /api/start": async (_req, res) => {
        if (!requireIdle(res)) return;
        if (!session.hasExecutor) return json(res, { error: "执行者未接入:启动时设置 EXECUTOR_MODULE" }, 400);
        if (!session.currentPlan) return json(res, { error: "先描述目标并生成方案。" }, 400);
        json(res, { ok: true });
        const mine = gen;
        const alive = () => mine === gen;
        notice = "";
        publish({ type: "thinking", who: "executor" });
        try {
          const running = session;
          const run = await running.start({
            onWave: (refs) => { if (!alive()) return; wave = refs; publish({ type: "wave", refs }); },
            onStep: ({ step, canvas }) => alive() && publish({ type: "step", step, canvas }),
          });
          if (!alive()) return;
          wave = null;
          publish({ type: "run", run, canvas: running.canvas, canvasPlanRevision: running.canvasPlanRevision });
        } catch (error) {
          if (!alive()) return;
          wave = null;
          publish({ type: "error", message: error.message, turn: session.turn });
        }
      },
      /* 节点只是发起位置。任务与返回的差量都覆盖完整工作流；会话负责检查和一次提交。 */
      "POST /api/revise": async (req, res, receivedIn) => {
        const request = await body(req);
        if (!requireCurrent(res, receivedIn)) return;
        if (storageError && !save()) return json(res, { error: storageError }, 503);
        notice = "";
        const mine = gen;
        const running = session;
        const alive = () => mine === gen && running === session;
        let pending;
        try {
          pending = running.revise(request, {
            onEdit: (edit) => {
              if (!alive()) return;
              publish({ type: "edit", edit, edits: running.edits,
                canvas: running.canvas, turn: running.turn, canvasPlanRevision: running.canvasPlanRevision });
            },
          });
        } catch (error) {
          return json(res, { error: error.message, turn: running.turn }, 400);
        }
        json(res, { ok: true }, 202);
        // 接受与完成分开：最终结果走 SSE，也留在 /api/state，刷新后仍可读取。
        Promise.resolve(pending).catch((error) => {
          if (alive()) publish({ type: "error", message: error.message, turn: running.turn });
        });
      },
      "POST /api/note": async (req, res, receivedIn) => {
        const { step, text } = await body(req);
        if (!requireCurrent(res, receivedIn)) return;
        try {
          const notes = session.annotate(step, text);
          publish({ type: "notes", notes });
          return json(res, { ok: true });
        } catch (error) {
          return json(res, { error: error.message }, 400);
        }
      },
      "POST /api/configure": async (req, res, receivedIn) => {
        const request = await body(req);
        if (!requireCurrent(res, receivedIn) || !requireIdle(res)) return;
        const canvas = session.configure(request);
        publish({ type: "configured", canvas });
        return json(res, storageError ? { error: storageError } : { ok: true, canvas }, storageError ? 503 : 200);
      },
      "POST /api/save": (_req, res) => {
        publish({ type: "saved" });
        return json(res, storageError ? { error: storageError } : { ok: true }, storageError ? 503 : 200);
      },
      "POST /api/stop": (_req, res) => json(res, { stopped: session.stop() }),
    };

    return { routes, snapshot, summary, save, record, notifyListing(data) { feed.send({ type: "sessions", ...data }); }, get generation() { return gen; },
      remove() { const before = record.deletedAt; record.deletedAt = new Date().toISOString(); if (!save()) { record.deletedAt = before; return; } gen += 1; session.stop(); feed.send({ type: "deleted" }); },
      restore() { const before = record.deletedAt; record.deletedAt = null; if (!save()) record.deletedAt = before; },
      rename(title) { const before = { title: record.title, renamed: record.renamed }; record.title = title; record.renamed = true; if (!save()) Object.assign(record, before); },
    };
  }

  for (const record of store.load()) {
    try {
      const runtime = runtimeFor(record);
      records.set(record.id, runtime);
      // 持久化中断标记，只恢复状态，不重新发起模型调用。
      if (record.workflow.turn !== "user") runtime.save();
    } catch (error) { store.warnings.push(`会话 ${record.title || record.id} 未能恢复，存档已保留：${error.message}`); }
  }
  const create = (presentation = {}, supplied, title) => {
    const now = new Date().toISOString();
    const record = { formatVersion: 1, id: randomUUID(), title: title ?? (presentation.task?.slice(0, 40) || "新工作流"), renamed: title !== undefined,
      createdAt: now, updatedAt: now, presentation };
    const runtime = runtimeFor(record, supplied);
    if (!runtime.save()) throw new Error(runtime.summary().storageError);
    records.set(record.id, runtime);
    broadcastList();
    return runtime;
  };
  if (initialSession) create(initialPresentation, initialSession);
  if (!list().length) create();
  const defaultId = list()[0].id;

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let route, runtime;
    try {
      if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, { sessions: list(), trash: list(true), warnings: store.warnings });
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const { title } = await body(req);
        if (title !== undefined && (typeof title !== "string" || !title.trim() || title.trim().length > 80)) return json(res, { error: "名称需为 1–80 个字符" }, 400);
        return json(res, { id: create({}, undefined, title?.trim()).record.id }, 201);
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);
      if (!match && storageDir && req.method !== "GET" && url.pathname.startsWith("/api/")) return json(res, { error: "会话管理已更新，请刷新页面后再发送；原工作流已保留。" }, 409);
      runtime = records.get(match?.[1] ?? defaultId);
      if (match && !runtime) return json(res, { error: "这条会话已不存在，请从左侧选择。" }, 404);
      if (match && (!match[2] || match[2] === "restore")) {
        if (req.method === "DELETE") runtime.remove();
        else if (req.method === "POST" && match[2] === "restore") runtime.restore();
        else if (req.method === "PATCH") {
          const { title } = await body(req);
          if (typeof title !== "string" || !title.trim() || title.trim().length > 80) return json(res, { error: "名称需为 1–80 个字符" }, 400);
          runtime.rename(title.trim());
        } else return json(res, { error: "不支持的操作" }, 405);
        broadcastList();
        const error = runtime.summary().storageError;
        return json(res, error ? { error } : { ok: true }, error ? 503 : 200);
      }
      if (runtime?.record.deletedAt && url.pathname.startsWith("/api/") && url.pathname !== "/api/node-table") return json(res, { error: "这条会话已删除，可以在左侧已删除列表恢复。" }, 410);
      const path = match ? `/api/${match[2]}` : url.pathname;
      route = runtime?.routes[`${req.method} ${path}`];
      if (route) return await route(req, res, runtime.generation);
      if (url.pathname.startsWith("/api/")) return json(res, { error: "接口不存在" }, 404);
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      const shared = rel.startsWith("/shared/");
      const staticRoot = shared ? join(ROOT, "shared") : WEB;
      const file = shared ? join(staticRoot, rel.slice("/shared/".length)) : join(WEB, rel);
      if (!file.startsWith(staticRoot + "/")) throw new Error("越界");
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPE[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch (error) {
      if (res.headersSent) return res.end();
      if (route || url.pathname.startsWith("/api/")) return json(res, { error: error.message, turn: runtime?.snapshot().turn }, 400);
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error.message));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 5174);
  (await createWebServer({ storageDir: resolve(process.env.SESSION_DIR ?? join(projectRoot, ".sessions")) }))
    .listen(port, "127.0.0.1", () => console.log(`画布在 http://127.0.0.1:${port}`));
}
