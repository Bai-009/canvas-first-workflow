/* 节点表怎么摆给模型看:十一行全常驻在提示词里,没有搜、没有查。
   每格后面一句怎么填,规矩从格子的种类来,不在提示词里另抄一遍。表本身在 src/nodes/node-table.mjs。 */
import { nodeTable } from "../nodes/node-table.mjs";

const withDefault = (slot, text) => (slot.default !== undefined ? `${text}; default ${JSON.stringify(slot.default)}` : text);

const howToFill = {
  source: (s) => `the user's: leave it out of params, list "${s.key}" in blanks`,
  credential: (s) => `the user's connection: leave it out of params, list "${s.key}" in blanks`,
  upload: (s) => `the user's: leave it out of params, list "${s.key}" in blanks; draft it yourself only when the plan states its content`,
  pick: (s) => withDefault(s, `pick one of: ${s.options.join(", ")}`),
  number: (s) => withDefault(s, "a number"),
  text: (s) => withDefault(s, "text"),
  body: () => "body: write it in full",
  conditions: () => 'condition: a boolean expression over input, e.g. input.text != ""; write it in full',
};

/* 摆的顺序按链走:起点、认内容、加工、过模型、落地、分岔、兜底。表里新加的类型排最后 */
const chainOrder = ["schedule", "readFile", "parseDocument", "ocr", "splitText", "embedText", "writeVectorStore", "llm", "writeDatabase", "condition", "code"];
const rank = (type) => (chainOrder.includes(type) ? chainOrder.indexOf(type) : chainOrder.length);

export function renderNodeTable(table = nodeTable()) {
  return [...table]
    .sort((a, b) => rank(a.type) - rank(b.type))
    .map((node) => {
      const slots = node.slots.length
        ? node.slots.map((s) => `  - ${s.key} (${s.label}): ${howToFill[s.kind](s)}`).join("\n")
        : "  slots: none";
      const ports = node.ports ? `\n  outputs: ${node.ports.join(", ")}` : "";
      return `- ${node.type} (${node.kind}) — ${node.summary}\n  in: ${node.input ?? "—"} → out: ${node.output}${ports}\n${slots}`;
    })
    .join("\n");
}
