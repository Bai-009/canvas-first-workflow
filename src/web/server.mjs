import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeTable } from "../nodes/node-table.mjs";
import { createWorkflowSession } from "../state-machine/workflow-session.mjs";
import { callerFromEnv, loadSystemPrompt } from "../plan/plan-agent.mjs";

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
  return {
    join(res) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hi\n\n");
      open.add(res);
      res.on("close", () => open.delete(res));
    },
    send(event) {
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of open) res.write(line);
    },
  };
}

/* 画布上按开始就是要真搭,所以执行者默认就是真的那个;
   要换成别的(比如测试用的固定答复)给 EXECUTOR_MODULE。 */
async function loadExecutor(env = process.env) {
  const which = env.EXECUTOR_MODULE ?? "src/executor/executor.mjs";
  if (which === "none") return null;
  const mod = await import(pathToFileURL(resolve(which)).href);
  if (typeof mod.default !== "function") throw new Error(`${which} 没有默认导出一个函数`);
  return mod.default;
}

export async function createWebServer() {
  const table = nodeTable();
  const feed = createFeed();
  const executor = await loadExecutor();
  const newSession = () => createWorkflowSession({
    callModel: callerFromEnv(),
    executor,
    systemPrompt: loadSystemPrompt(process.env.PLAN_PROMPT_LANG || "zh"),
  });
  let session = newSession();
  let task = "";
  let speech = "";
  /* 这一条从头到尾说了什么,一句一句留着:Plan Agent 就是在这里跟人说话的。
     模型手里那份 transcript 是给模型看的(带 tool 调用和结果),不是给人读的。 */
  let chat = [];
  let wave = null;
  /* 新开一条:上一条正在跑的先叫停,它后面再交回来的东西不算数。 */
  let gen = 0;

  const routes = {
    "GET /api/node-table": (_req, res) => json(res, table),
    "GET /api/events": (_req, res) => feed.join(res),
    "GET /api/state": (_req, res) => json(res, {
      task, speech, chat, wave, canvas: session.canvas, plan: session.currentPlan, revision: session.revision,
      turn: session.turn, hasExecutor: session.hasExecutor, annotations: session.annotations,
    }),
    "POST /api/say": async (req, res) => {
      const { text } = await body(req);
      if (!text?.trim()) return json(res, { error: "说了空话" }, 400);
      if (!task) task = text.trim();
      chat = [...chat, { who: "user", text: text.trim() }];
      feed.send({ type: "thinking", who: "plan" });
      /* 边写边看:模型还在写的时候,把手上这半份推给页面。
         这一轮它的话还在写,所以草稿单独走 speech,不进 chat。 */
      const turn = await session.say(text.trim(), {
        onDraft: (draft) => feed.send({ type: "draft", task, chat, ...draft }),
      });
      speech = turn.speech ?? "";
      if (speech) chat = [...chat, { who: "agent", text: speech }];
      feed.send({ type: "plan", task, chat, plan: turn.plan, diff: turn.diff, revision: turn.revision, speech });
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
      feed.send({ type: "reset" });
      return json(res, { ok: true });
    },
    "POST /api/start": async (_req, res) => {
      if (!session.hasExecutor) return json(res, { error: "执行者未接入:启动时设置 EXECUTOR_MODULE" }, 400);
      json(res, { ok: true });
      const mine = gen;
      const alive = () => mine === gen;
      feed.send({ type: "thinking", who: "executor" });
      try {
        const running = session;
        const run = await running.start({
          onWave: (refs) => { if (!alive()) return; wave = refs; feed.send({ type: "wave", refs }); },
          onStep: ({ step, canvas }) => alive() && feed.send({ type: "step", step, canvas }),
        });
        if (!alive()) return;
        wave = null;
        feed.send({ type: "run", run, canvas: running.canvas });
      } catch (error) {
        if (!alive()) return;
        wave = null;
        feed.send({ type: "error", message: error.message });
      }
    },
    "POST /api/note": async (req, res) => {
      const { step, text } = await body(req);
      try {
        const notes = session.annotate(step, text);
        feed.send({ type: "notes", notes });
        return json(res, { ok: true });
      } catch (error) {
        return json(res, { error: error.message }, 400);
      }
    },
    "POST /api/stop": (_req, res) => json(res, { stopped: session.stop() }),
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = routes[`${req.method} ${url.pathname}`];
    try {
      if (route) return await route(req, res);
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      const file = join(WEB, rel);
      if (!file.startsWith(WEB)) throw new Error("越界");
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPE[extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch (error) {
      if (res.headersSent) return res.end();
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error.message));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 5173);
  (await createWebServer()).listen(port, () => console.log(`画布在 http://localhost:${port}`));
}
