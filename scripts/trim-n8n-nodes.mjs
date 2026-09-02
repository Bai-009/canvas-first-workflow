/* 把 .cache/n8n/ 里的原始导出精简成 fixtures/n8n/catalog.json。
   每个节点只留当前版本;参数只留执行者填参数时要看的:名字、类型、默认值、必填、说明、什么条件下显示、
   选项的取值。提示类的假参数(notice/callout/hidden/button)去掉,它们是给网页界面看的。 */
import { readFileSync, writeFileSync } from "node:fs";

const SKIP = new Set(["notice", "callout", "hidden", "button"]);

export function trimProperties(props = []) {
  return props
    .filter((p) => !SKIP.has(p.type))
    .map((p) => {
      const out = { displayName: p.displayName, name: p.name, type: p.type };
      if (p.default !== undefined) out.default = p.default;
      if (p.required) out.required = true;
      if (p.description) out.description = p.description;
      if (p.placeholder) out.placeholder = p.placeholder;
      if (p.displayOptions) out.displayOptions = p.displayOptions;
      if (p.typeOptions?.multipleValues) out.multipleValues = true;
      if (Array.isArray(p.options)) {
        if (p.type === "options" || p.type === "multiOptions") {
          out.options = p.options.map((o) => {
            const item = { name: o.name, value: o.value };
            if (o.description) item.description = o.description;
            return item;
          });
        } else if (p.type === "collection") {
          out.options = trimProperties(p.options);
        } else if (p.type === "fixedCollection") {
          out.options = p.options.map((o) => ({ displayName: o.displayName, name: o.name, values: trimProperties(o.values) }));
        }
      }
      if (p.type === "resourceLocator" && p.modes) out.modes = p.modes.map((m) => m.name);
      return out;
    });
}

/* resource / operation 两个下拉里的选项名(带说明),搜索时用:节点叫什么之外,还能搜它能做什么 */
function operationNames(props = []) {
  const names = [];
  for (const p of props) {
    if ((p.name === "operation" || p.name === "resource") && p.type === "options" && Array.isArray(p.options)) {
      for (const o of p.options) names.push(o.description ? `${o.name}: ${o.description}` : String(o.name));
    }
  }
  return [...new Set(names)];
}

export function trimNode(entry) {
  const current = entry.versions
    ? entry.versions[String(entry.currentVersion)] ?? entry.versions[Object.keys(entry.versions).at(-1)]
    : entry.description;
  const version = Array.isArray(current.version) ? current.version.at(-1) : current.version;
  return {
    name: current.name,
    displayName: current.displayName,
    description: current.description ?? "",
    group: current.group ?? [],
    version,
    hidden: current.hidden === true,   // 旧版、已下架的节点,界面里搜不到,我们也不给模型
    inputs: current.inputs,
    outputs: current.outputs,
    credentials: (current.credentials ?? []).map((c) => ({ name: c.name, required: c.required !== false })),
    aliases: current.codex?.alias ?? [],
    operations: operationNames(current.properties),   // 它能做的操作的名字,搜索时也看这里
    categories: current.codex?.categories ?? [],
    properties: trimProperties(current.properties),
  };
}

function main() {
  const packages = ["nodes-base", "nodes-langchain"].map((n) => JSON.parse(readFileSync(`.cache/n8n/${n}.json`, "utf8")));
  const n8nVersion = readFileSync(".cache/n8n/n8n-version.txt", "utf8").trim();
  const nodes = [];
  for (const pkg of packages) {
    for (const entry of pkg.nodes) {
      const node = trimNode(entry);
      node.package = pkg.package;
      node.type = `${pkg.package}.${node.name}`;
      nodes.push(node);
    }
  }
  nodes.sort((a, b) => a.type.localeCompare(b.type));
  const catalog = {
    source: `n8n ${n8nVersion} 官方 Docker 镜像,${packages.map((p) => `${p.package}@${p.version}`).join(" + ")}`,
    exportedAt: new Date().toISOString().slice(0, 10),
    count: nodes.length,
    nodes,
  };
  writeFileSync("fixtures/n8n/catalog.json", JSON.stringify(catalog));
  console.log(`fixtures/n8n/catalog.json:${nodes.length} 个节点,${(JSON.stringify(catalog).length / 1e6).toFixed(1)} MB,来源 ${catalog.source}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
