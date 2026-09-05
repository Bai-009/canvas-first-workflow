import type { PlanProposal } from "../../shared/contracts.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../runtime-paths.mjs";
import { inspectPlanProposal } from "../plan/validate-plan-proposal.mjs";
import { diffPlans } from "../plan/plan-diff.mjs";

/* 原型演示的数据从这里生成,不在前端代码里手写。
   来源是 fixtures/observed/ 里真实模型输出的一对修订轮方案:
   第一轮(四个待确认)→ 用户补一句 → 第二轮(s2 原地长出 OCR,q1 q2 清掉)。
   两份都先过闸门,闸门不放行就不生成。
   "哪些问题被答掉了""哪一步原地改了"不靠手标,靠编号差异算出来——
   跟界面上"沿用编号=原地改"用的是同一个机制。 */

const read = (rel: string, name: string): PlanProposal => {
  const value: unknown = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
  const gate = inspectPlanProposal(value);
  if (!gate.ok) {
    console.error(`${name}方案没过闸门:\n${gate.errors.join("\n")}`);
    process.exit(1);
  }
  return gate.plan;
};
const before = read("../../fixtures/observed/run4-修订轮/turn-1.plan.json", "第一轮");
const after = read("../../fixtures/observed/run4-修订轮/turn-2.plan.json", "第二轮");

/* 对话实录(与 docs/观察.md 一致) */
const TASK = "每天定时把新增的合同 PDF 解析出关键字段,写进数据库";
const REPLY = "PDF 都是扫描件。「新增」按文件落库时间算,每天处理昨天落库的。";

const pairs = (plan: PlanProposal) => plan.understanding.map((r) => [r.quote, r.reading]);
const route = (plan: PlanProposal) => plan.steps.map((s) => s.title);
const doneLine = (plan: PlanProposal) =>
  `${plan.steps.length} 步 · ${
    plan.openQuestions.length ? `${plan.openQuestions.length} 项待确认` : "待确认已清"
  }`;

const gone = new Set(diffPlans(before, after).openQuestions.removed);
const answeredAsks = before.openQuestions
  .map((q, i) => (gone.has(q.ref) ? i : null))
  .filter((i) => i !== null);

const data = {
  task: TASK,
  wfName: "合同要素入库",
  understanding: pairs(before),
  route: route(before),
  asks: before.openQuestions.map((q) => [q.question, q.reason]),
  done: doneLine(before),
  reply: REPLY,
  after: {
    understanding: pairs(after),
    route: route(after),
    answeredAsks,
    done: doneLine(after),
  },
};

const out = join(projectRoot, "prototype/plan-data.js");
writeFileSync(
  out,
  `/* 由 src/prototype/build-demo-data.mts 生成,不要手改。
   数据是真实模型输出(fixtures/observed/ 的修订轮一对),生成时已过闸门。 */
window.PLAN_DATA = ${JSON.stringify(data, null, 2)};
`
);
console.log(`已生成 ${out}`);
console.log(`答掉的问题(按编号差异):${answeredAsks.map((i) => before.openQuestions[i]?.ref).join("、")}`);
