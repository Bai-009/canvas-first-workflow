import { readFileSync } from "node:fs";

/* 执行者查平台用的目录。数据是 fixtures/n8n/catalog.json,从 n8n 官方镜像导出再精简(scripts/dump-n8n-nodes.sh)。
   三层披露:常驻在提示词里的十来个常用节点一行一个(summarize);模型说要找什么,searchNodes 回最像的几个,
   只有名字和一句话;模型点名要哪个,describeNode 才把参数说明给它,而且像 Postgres 这种分操作的节点,
   先给操作菜单,说了做哪种操作才给那种操作的参数。 */

const catalogUrl = new URL("../../fixtures/n8n/catalog.json", import.meta.url);
let cached = null;

export function loadCatalog() {
  if (!cached) cached = JSON.parse(readFileSync(catalogUrl, "utf8"));
  return cached;
}

/* 原样的词(小写、按非字母数字切),再加上驼峰拆开的词:"DeepSeek" 同时算 deepseek、deep、seek,
   这样用户随手写的 deepseek 和代码名里的 lmChatDeepSeek 都对得上。 */
const rawWords = (text) =>
  String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
const words = (text) => {
  const raw = rawWords(text);
  const camel = rawWords(String(text ?? "").replace(/([a-z])([A-Z])/g, "$1 $2"));
  return [...new Set([...raw, ...camel])];
};

const STOP = new Set(["the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "with", "from", "by", "at", "is", "it", "node", "nodes", "data", "into", "use", "using"]);

/* 名字里的词最重;整个名字都被查询词覆盖再加一笔,好让 "Postgres" 压过 "Postgres Chat Memory";
   它能做的操作也算,好让搜 "ocr" 找得到操作叫 Extract Text (OCR) 的节点;一句话说明最轻。 */
function scoreNode(node, tokens) {
  const display = words(node.displayName);
  const displayRaw = rawWords(node.displayName).filter((w) => !STOP.has(w));
  const name = words(node.name);
  const aliases = node.aliases.flatMap(words);
  const desc = words(node.description);
  const ops = (node.operations ?? []).flatMap(words);
  const cats = [...node.categories, ...node.group].flatMap(words);
  let score = 0;
  let displayHits = 0;
  for (const token of tokens) {
    if (display.includes(token)) { score += 6; displayHits += 1; }
    else if (display.some((w) => w.startsWith(token) || token.startsWith(w))) score += 3;
    if (name.includes(token)) score += 3;
    if (aliases.includes(token)) score += 4;
    if (ops.includes(token)) score += 2;
    if (desc.includes(token)) score += 2;
    if (cats.includes(token)) score += 1;
  }
  if (displayRaw.length > 0 && displayRaw.every((w) => tokens.includes(w))) score += 4;
  return score;
}

export function searchNodes(query, { limit = 6 } = {}) {
  const tokens = [...new Set(words(query).filter((w) => !STOP.has(w)))];
  if (tokens.length === 0) return [];
  const hits = loadCatalog()
    .nodes.filter((node) => !node.hidden)
    .map((node) => ({ node, score: scoreNode(node, tokens) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.node.displayName.length - b.node.displayName.length)
    .slice(0, limit);
  return hits.map(({ node }) => brief(node));
}

/* inputs/outputs 偶尔是表达式字符串(随参数变),那种当普通节点看 */
function kindOf(node) {
  if (Array.isArray(node.outputs) && node.outputs.some((o) => o !== "main")) return "sub-node";
  if (Array.isArray(node.inputs) && node.inputs.length === 0) return "trigger";
  return "action";
}

const brief = (node) => ({
  type: node.type,
  displayName: node.displayName,
  description: node.description,
  kind: kindOf(node),
});

export function findNode(type) {
  const nodes = loadCatalog().nodes;
  return nodes.find((n) => n.type === type) ?? nodes.find((n) => n.name === type) ?? null;
}

/* displayOptions 只按 resource / operation 两把闸过滤;条件依赖别的参数的一律保留,宁多不漏。 */
function shownUnder(prop, chosen) {
  const { show, hide } = prop.displayOptions ?? {};
  for (const key of Object.keys(chosen)) {
    if (chosen[key] === undefined) continue;
    if (show?.[key] && !show[key].includes(chosen[key])) return false;
    if (hide?.[key] && hide[key].includes(chosen[key])) return false;
  }
  return true;
}

const gatedByOperation = (prop) => Boolean(prop.displayOptions?.show?.operation || prop.displayOptions?.hide?.operation);

export function describeNode(type, { resource, operation } = {}) {
  const node = findNode(type);
  if (!node) {
    const near = searchNodes(type, { limit: 3 }).map((n) => n.type);
    throw new Error(`目录里没有 ${type}${near.length ? `,像的有:${near.join("、")}` : ""}`);
  }
  const chosen = { resource, operation };
  let properties = node.properties.filter((p) => shownUnder(p, chosen));
  const operationProp = properties.find((p) => p.name === "operation" && p.type === "options");
  const out = {
    type: node.type,
    displayName: node.displayName,
    description: node.description,
    version: node.version,
    inputs: node.inputs,
    outputs: node.outputs,
    credentials: node.credentials,
  };
  if (operationProp && operation === undefined && operationProp.options.length > 1) {
    /* 先给菜单:有哪些操作;参数只给不随操作变的那些 */
    out.operations = operationProp.options.map((o) => ({ value: o.value, name: o.name, description: o.description }));
    out.hint = "这个节点分操作。选定操作后再查一次,带上 operation,才给那种操作的参数。";
    properties = properties.filter((p) => p.name !== "operation" && !gatedByOperation(p));
  } else if (operationProp && operation !== undefined) {
    if (!operationProp.options.some((o) => o.value === operation)) {
      throw new Error(`${node.displayName} 没有 ${operation} 这种操作,有:${operationProp.options.map((o) => o.value).join("、")}`);
    }
    properties = properties.map((p) => (p === operationProp ? { ...p, options: p.options.filter((o) => o.value === operation) } : p));
  }
  out.properties = properties;
  return out;
}

/* 常驻在提示词里的那几行:名字、类型标识、一句话。 */
export function summarize(types) {
  return types.map((type) => {
    const node = findNode(type);
    if (!node) throw new Error(`目录里没有 ${type}`);
    return `${node.displayName} (${node.type}): ${node.description}`;
  });
}

/* 给模型的两个查目录的工具,OpenAI 兼容格式。工具怎么用写在这里,提示词里只留判断。
   第三个工具 submit_step 在 submit-step-tool.mjs。 */
export const catalogTools = [
  {
    type: "function",
    function: {
      name: "search_nodes",
      description:
        "Search the platform's node catalog by keywords. Use it when no resident node fits the action this step needs. " +
        "Give 2-5 English keywords naming the action and the object (\"ocr pdf image\", \"insert rows postgres\", \"send message slack\"); node names and descriptions are in English. " +
        "Returns up to 6 candidates, each with type, display name, a one-line description and its kind (trigger, action or sub-node). " +
        "Pick one and call describe_node; if nothing fits, search again with different words.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "2-5 English keywords for the action and its object" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_node",
      description:
        "Return a node's parameters: name, type, default, whether required, allowed options, plus the credentials the node needs. " +
        "Call it for every node you will use, before filling parameters. " +
        "Nodes with several operations (Postgres, Extract from File, HTTP Request, ...) return an operation menu first and no operation-specific parameters; " +
        "call again with `operation` (and `resource`, when the menu lists resources) set to one of the menu values to get that operation's parameters. " +
        "A parameter name that is not in this response does not exist on the node.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Node type exactly as returned by search_nodes or listed under resident nodes, e.g. n8n-nodes-base.postgres" },
          resource: { type: "string", description: "One of the resource values from the menu, when the node has resources" },
          operation: { type: "string", description: "One of the operation values from the menu" },
        },
        required: ["type"],
        additionalProperties: false,
      },
    },
  },
];
