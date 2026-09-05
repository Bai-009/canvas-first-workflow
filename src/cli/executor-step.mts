import { inspectPlanProposal } from '../plan/validate-plan-proposal.mjs';
import { isCanvas } from '../storage/session-record.mjs';
import { errorMessage, errorDetails } from '../../shared/errors.mjs';
import type { StepOutcome } from "../../shared/workflow.mjs";
import type { Canvas } from '../../shared/contracts.mjs';
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleTable } from "../state-machine/step-context.mjs";
import { callerFromEnv, loadSystemPrompt, runStep } from "../executor/executor.mjs";
import { describe } from "./describe-event.mjs";

/* 单独跑一步,不接状态机:拿一份方案、指一步,画布默认空的,执行者交了什么、被退了什么打出来。
   --plan <方案文件> --step s1 [--canvas <画布文件>] [--save <目录>] [--rounds 30]
   --save 把整段对话、模型交的原样、状态机认的形状、桌上的五样和这份记录存下来,fixtures/observed/ 里的实录就这么来。 */
function parseArgs(argv: string[]) {
  const args: { plan?: string; step?: string; canvas?: string; save?: string; rounds: number } = { rounds: 30 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.replace(/^--/, "");
    if (key === 'rounds' || key === 'plan' || key === 'step' || key === 'canvas' || key === 'save') {
      const value = argv[++i];
      if (value === undefined) { console.error(`--${key} 缺少值`); process.exit(2); }
      if (key === 'rounds') args.rounds = Number(value);
      else args[key] = value;
    }
  }
  if (!args.plan || !args.step) {
    console.error("用法:--plan <方案文件> --step s1 [--canvas <画布文件>] [--save <目录>] [--rounds 30]");
    process.exit(2);
  }
  return { ...args, plan: args.plan, step: args.step };
}

const args = parseArgs(process.argv.slice(2));
const incomingPlan: unknown = JSON.parse(readFileSync(args.plan, "utf8"));
const gate = inspectPlanProposal(incomingPlan);
if (!gate.ok) { console.error(gate.errors.join("\n")); process.exit(1); }
const plan = gate.plan;
const incomingCanvas: unknown = args.canvas ? JSON.parse(readFileSync(args.canvas, "utf8")) : { nodes: [], edges: [], version: 0 };
if (!isCanvas(incomingCanvas)) { console.error("画布文件格式无效"); process.exit(1); }
const canvas: Canvas = incomingCanvas;
const context = assembleTable(plan, args.step, { canvas, annotations: [] });
const trace: string[] = [];
const say = (line: string) => { trace.push(line); console.log(line); };

say(`${args.step} · ${context.step.title}`);
let outcome: (StepOutcome & { error?: never }) | { messages?: unknown; events?: unknown; error: string; submission?: never; result?: never };
try {
  outcome = await runStep(context, {
    callModel: callerFromEnv(),
    systemPrompt: loadSystemPrompt(),
    maxRounds: args.rounds,
    onEvent: (event) => say(`[${event.round}] ${describe(event)}`),
  });
  say(`${outcome.rounds} 个回合交了`);
} catch (error) {
  say(`没交成:${errorMessage(error)}`);
  outcome = { messages: errorDetails(error).messages, events: errorDetails(error).events, error: errorMessage(error) };
}

if (args.save) {
  const directory = args.save;
  mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(directory, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  write("context.json", context);
  if (outcome.messages) write("messages.json", outcome.messages);
  if (outcome.submission) write("submission.json", outcome.submission);
  if (outcome.result) write("patch.json", outcome.result);
  write("trace.txt", `${trace.join("\n")}\n`);
  say(`存在 ${args.save}`);
}
if (outcome.error) process.exit(1);
