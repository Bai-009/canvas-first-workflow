import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeTable } from "../nodes/node-table.mjs";

/* 画布这一头的服务。现在只做一件事:把节点表和一份画布交给前端,
   让卡片是照数据画出来的,不是手写的。往下要接的是活的会话。 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB = join(ROOT, "web");
const TYPE = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

const DEFAULT_CANVAS = "fixtures/observed/run13-知识库-自己的节点表";

const json = (res, data) => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

async function canvasOf(dir) {
  const canvas = JSON.parse(await readFile(join(ROOT, dir, "canvas.json"), "utf8"));
  const input = await readFile(join(ROOT, dir, "输入.txt"), "utf8").catch(() => "");
  canvas.task = input.split("\n")[0] ?? "";
  return canvas;
}

export function createWebServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/node-table") return json(res, nodeTable());
      if (url.pathname === "/api/canvas") return json(res, await canvasOf(url.searchParams.get("run") ?? DEFAULT_CANVAS));
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      const file = join(WEB, rel);
      if (!file.startsWith(WEB)) throw new Error("越界");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPE[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error.message));
    }
  });
}

const port = Number(process.env.PORT ?? 5173);
createWebServer().listen(port, () => console.log(`画布在 http://localhost:${port}`));
