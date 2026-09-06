import type { Canvas, PlanProposal, StepContext } from '../../shared/contracts.mjs';
import type { AgentEvent, Executor, Run, StepRecord } from '../../shared/workflow.mjs';
import type { WorkflowSession } from '../state-machine/workflow-session.mjs';
import type { PlanDiff } from '../plan/plan-diff.mjs';
import { isRecord } from '../../shared/json.mjs';
import { errorMessage, errorName } from '../../shared/errors.mjs';
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { callerFromEnv, loadSystemPrompt } from "../plan/plan-agent.mjs";
import { createWorkflowSession } from "../state-machine/workflow-session.mjs";
import { describe } from "./describe-event.mjs";
import { resolveRuntimeModule } from "../runtime-paths.mjs";

/* 多轮命令:一行一轮。对话记录攒着,过了闸门的方案换成当前方案,
   正在跑的一轮可以 Ctrl-C 停掉(那轮作废,只留你那句)。
   斜杠开头的是按钮:/start 开始走步,/note s1 文字 批注,/canvas 看画布,/help。
   执行者是插口:EXECUTOR_MODULE=路径 插一个进来(默认导出一个 async 函数);没插的时候 /start 会明说。
   真执行者是 src/executor/executor.mjs;fixtures/doubles/fixed-executor.mjs 是测试用的固定答复。
   走步时执行者交了什么、被退了什么一行行印出来,前面带步号。
   --save <目录> 把每一轮的原始输出、完整对话记录、每次走步的记录和画布存下来,fixtures/observed/ 里的实录就这么来;
   执行者每一步自己的对话记录存在 <目录>/executor/ 下(EXECUTOR_SAVE 没另设的话)。
   --lang en 用英文提示词。 */

function parseArgs(argv: string[]) {
  const args: { save?: string | undefined; lang: string } = { lang: process.env.PLAN_PROMPT_LANG || "zh" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--save") args.save = argv[++i];
    else if (argv[i] === "--lang") args.lang = argv[++i] ?? "zh";
  }
  return args;
}

function mark(diff: PlanDiff | null, section: keyof PlanDiff, ref: string) {
  if (!diff) return "";
  const d = diff[section];
  if (d.added.includes(ref)) return "  ← 新增";
  if (d.changed.includes(ref)) return "  ← 原地改";
  return "";
}

function render(plan: PlanProposal, diff: PlanDiff | null, revision: number) {
  const open = plan.openQuestions.length;
  const lines = [
    `方案 v${revision} · ${plan.readiness} · ${plan.steps.length} 步 · ${open ? `${open} 项待确认` : "待确认已清"}`,
    `目标:${plan.goal}`,
    "理解",
  ];
  for (const u of plan.understanding) {
    lines.push(`  ${u.ref.padEnd(4)}「${u.quote}」→ ${u.reading}${mark(diff, "understanding", u.ref)}`);
  }
  lines.push("路线");
  for (const s of plan.steps) {
    lines.push(`  ${s.ref.padEnd(4)}${s.title}${mark(diff, "steps", s.ref)}`);
    lines.push(`      进:${s.input}`);
    lines.push(`      出:${s.output}`);
  }
  if (open) {
    lines.push("待确认");
    for (const q of plan.openQuestions) {
      lines.push(`  ${q.ref.padEnd(4)}${q.question}${mark(diff, "openQuestions", q.ref)}`);
      lines.push(`      为什么:${q.reason}`);
      if (q.options?.length) lines.push(`      备选:${q.options.join(" / ")}`);
    }
  }
  if (diff) {
    const gone = [
      ...diff.openQuestions.removed.map((r) => `${r}(答掉了)`),
      ...diff.steps.removed,
      ...diff.understanding.removed,
    ];
    lines.push(`上一版里消失的:${gone.length ? gone.join("、") : "无"}`);
  }
  return lines.join("\n");
}

const OUTCOME: Record<StepRecord["outcome"], (step: StepRecord) => string> = {
  done: (s) => `做完 → 画布 v${s.canvasVersion} · 节点 ${(s.nodes ?? []).join("、")}`,
  covered: (s) => `已经有了 · 画布还是 v${s.canvasVersion}`,
  stopped: (s) => `停了,这一步作废 · 画布停在 v${s.canvasVersion}`,
  rejected: (s) => `没收,停在这一步 · ${(s.reasons ?? []).join(";")}`,
  failed: (s) => `出错,停在这一步 · ${s.error}`,
};
const ENDED: Partial<Record<NonNullable<Run["endedBy"]>, string>> = {
  finished: "跑完,轮到你",
  stopped: "被你停了,轮到你",
  rejected: "执行者交的东西查不过,轮到你",
  error: "执行者出错,轮到你",
};

function renderRun(run: Run, index: number) {
  const lines = [`第 ${index} 次走步 · 按的是方案 v${run.revision}`];
  for (const s of run.steps) lines.push(`  ${s.ref.padEnd(4)}${OUTCOME[s.outcome](s)}`);
  lines.push(`  ${run.endedBy ? ENDED[run.endedBy] : undefined}`);
  if (run.endedBy === "finished") {
    lines.push(
      run.problems.length
        ? `  整张画布查了一遍,有问题:\n    ${run.problems.join("\n    ")}`
        : "  整张画布查了一遍,线都接上了"
    );
  }
  return lines.join("\n");
}

function renderCanvas(canvas: Canvas) {
  if (canvas.nodes.length === 0) return `画布 v${canvas.version} · 空的`;
  const lines = [`画布 v${canvas.version} · ${canvas.nodes.length} 个节点 · ${canvas.edges.length} 条线`];
  for (const n of canvas.nodes) {
    const blanks = n.blanks.length ? ` · 留空:${n.blanks.join("、")}` : "";
    lines.push(`  ${n.name}  [${n.step}] ${n.type}${blanks}`);
    if (n.note) lines.push(`      「${n.note}」`);
  }
  for (const e of canvas.edges) lines.push(`  ${e.from} → ${e.to}`);
  return lines.join("\n");
}

function save(dir: string, session: WorkflowSession, turnNumber: number, turn: { plan: PlanProposal | null; speech: string }) {
  writeFileSync(join(dir, "transcript.json"), `${JSON.stringify(session.transcript, null, 2)}\n`);
  if (turn.plan) {
    writeFileSync(join(dir, `turn-${turnNumber}.plan.json`), `${JSON.stringify(turn.plan, null, 2)}\n`);
  }
  if (turn.speech) writeFileSync(join(dir, `turn-${turnNumber}.speech.txt`), `${turn.speech}\n`);
}

function saveRun(dir: string, session: WorkflowSession, run: Run, index: number) {
  writeFileSync(join(dir, `run-${index}.json`), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(dir, "canvas.json"), `${JSON.stringify(session.canvas, null, 2)}\n`);
  writeFileSync(join(dir, "annotations.json"), `${JSON.stringify(session.annotations, null, 2)}\n`);
}

const printEvent = (event: AgentEvent, context: StepContext) => console.log(`  [${context.step.ref} ${event.round}] ${describe(event)}`);

async function loadExecutor(env = process.env): Promise<{ executor: Executor | null; label: string | null }> {
  if (!env.EXECUTOR_MODULE) return { executor: null, label: null };
  const url = pathToFileURL(resolveRuntimeModule(env.EXECUTOR_MODULE)).href;
  const mod: unknown = await import(url);
  if (!isRecord(mod) || typeof mod.default !== "function") throw new Error(`${env.EXECUTOR_MODULE} 没有默认导出一个函数`);
  const call = mod.default;
  return { executor: async (context, options) => call(context, options), label: env.EXECUTOR_MODULE };
}

/* 终端里一问一答;管道进来的(比如脚本喂几行)先整个读完再逐行跑,
   否则模型在推的时候到达的那几行没人接,会被 readline 丢掉。 */
async function* lines(rl: readline.Interface) {
  if (input.isTTY) {
    for (;;) {
      try {
        yield await rl.question("\n你:");
      } catch {
        return;
      }
    }
  }
  const queued: string[] = [];
  for await (const line of rl) queued.push(line);
  for (const line of queued) {
    output.write(`\n你:${line}\n`);
    yield line;
  }
}

const HELP = [
  "一行一轮,直接打字就是对 Plan Agent 说话。",
  "/start          按开始:从 s1 起一步一步交给执行者",
  "/note r1 文字   在 r1 上批注(编号以方案里印的为准),下次 /start 时执行者会看到",
  "/replan         把断口交给设计者:停在哪一步、闸门退了什么,原样说给它,让它出新方案",
  "/canvas         看画布现在的样子",
  "/help           这份说明",
  "正在跑的时候 Ctrl-C 停掉这一轮;没在跑的时候 Ctrl-C 退出。",
].join("\n");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.save && !process.env.EXECUTOR_SAVE) process.env.EXECUTOR_SAVE = join(args.save, "executor");
  let callModel;
  let plug;
  try {
    callModel = callerFromEnv();
    plug = await loadExecutor();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 2;
    return;
  }
  const executor = plug.executor;
  const session = createWorkflowSession({
    callModel,
    executor: executor && ((context, options) => executor(context, { ...options, onEvent: printEvent })),
    systemPrompt: loadSystemPrompt(args.lang),
  });
  if (args.save) mkdirSync(args.save, { recursive: true });

  const rl = readline.createInterface({ input, output });
  const onInterrupt = () => {
    const stopped = session.stop();
    if (stopped === "plan") {
      output.write("\n（已停止,这轮作废,只留下你那句。）\n");
      return;
    }
    if (stopped === "executor") {
      output.write("\n（已停止,正在做的这一步作废,画布停在上次提交。）\n");
      return;
    }
    output.write("\n再见。\n");
    process.exit(0);
  };
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);

  console.log(HELP);
  console.log(
    plug.label
      ? `执行者插的是:${plug.label}`
      : "执行者的位置空着:/start 会明说做不了。插真的:EXECUTOR_MODULE=src/executor/executor.mjs;只想看状态机怎么动:EXECUTOR_MODULE=fixtures/doubles/fixed-executor.mjs(测试用的固定答复,不是真执行者)。"
  );
  let turnNumber = 0;
  let runNumber = 0;
  for await (const line of lines(rl)) {
    const text = (line ?? "").trim();
    if (!text) continue;

    if (text === "/help") {
      console.log(HELP);
      continue;
    }
    if (text === "/canvas") {
      console.log(renderCanvas(session.canvas));
      continue;
    }
    if (text.startsWith("/note")) {
      const [, step, ...rest] = text.split(/\s+/);
      try {
        const notes = session.annotate(step ?? "", rest.join(" "));
        console.log(`批注挂在 ${step} 上了。现在挂着的:\n${notes.map((n) => `  ${n.step}  ${n.text}`).join("\n")}`);
      } catch (error) {
        console.error(errorMessage(error));
      }
      continue;
    }
    if (text === "/start") {
      output.write("…走步中\n");
      let run;
      try {
        run = await session.start();
      } catch (error) {
        console.error(errorMessage(error));
        continue;
      }
      runNumber += 1;
      console.log(`\n${renderRun(run, runNumber)}`);
      console.log(renderCanvas(session.canvas));
      if (args.save) saveRun(args.save, session, run, runNumber);
      continue;
    }
    const handoff = text === "/replan";
    if (text.startsWith("/") && !handoff) {
      console.log(`没有 ${text} 这个按钮。\n${HELP}`);
      continue;
    }

    turnNumber += 1;
    output.write("…模型在推\n");
    let turn;
    try {
      turn = await (handoff ? session.escalate({ onSaid: (said) => output.write(`${said}\n`) }) : session.say(text));
    } catch (error) {
      if (errorName(error) !== "AbortError") console.error(`这轮失败:${errorMessage(error)}`);
      if (args.save) save(args.save, session, turnNumber, { speech: "", plan: null });
      continue;
    }
    if (turn.speech) console.log(`\n${turn.speech}`);
    if (turn.plan) console.log(`\n${render(turn.plan, turn.diff, turn.revision)}`);
    else console.log("（这一轮没提交方案,只说了话。）");
    if (args.save) save(args.save, session, turnNumber, turn);
  }
  rl.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
