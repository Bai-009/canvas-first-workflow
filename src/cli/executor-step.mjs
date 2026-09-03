import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assembleTable } from "../state-machine/step-context.mjs";
import { callerFromEnv, loadSystemPrompt, runStep } from "../executor/executor.mjs";
import { describe } from "./describe-event.mjs";

/* 单独跑一步,不接状态机:拿一份方案、指一步,画布默认空的,执行者搜了什么、查了什么、交了什么打出来。
   --plan <方案文件> --step s1 [--canvas <画布文件>] [--save <目录>] [--rounds 12]
   --save 把整段对话、模型交的原样、状态机认的形状、桌上的五样和这份记录存下来,fixtures/observed/ 里的实录就这么来。 */
function parseArgs(argv) {
  const args = { plan: null, step: null, canvas: null, save: null, rounds: 12 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key in args) args[key] = key === "rounds" ? Number(argv[++i]) : argv[++i];
  }
  if (!args.plan || !args.step) {
    console.error("用法:--plan <方案文件> --step s1 [--canvas <画布文件>] [--save <目录>] [--rounds 12]");
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const plan = JSON.parse(readFileSync(args.plan, "utf8"));
const canvas = args.canvas ? JSON.parse(readFileSync(args.canvas, "utf8")) : { nodes: [], edges: [], version: 0 };
const context = assembleTable(plan, args.step, { canvas, annotations: [] });
const trace = [];
const say = (line) => { trace.push(line); console.log(line); };

say(`${args.step} · ${context.step.title}`);
let outcome;
try {
  outcome = await runStep(context, {
    callModel: callerFromEnv(),
    systemPrompt: loadSystemPrompt(),
    maxRounds: args.rounds,
    onEvent: (event) => say(`[${event.round}] ${describe(event)}`),
  });
  say(`${outcome.rounds} 个回合交了`);
} catch (error) {
  say(`没交成:${error.message}`);
  outcome = { messages: error.messages, events: error.events, error: error.message };
}

if (args.save) {
  mkdirSync(args.save, { recursive: true });
  const write = (name, value) => writeFileSync(join(args.save, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  write("context.json", context);
  if (outcome.messages) write("messages.json", outcome.messages);
  if (outcome.submission) write("submission.json", outcome.submission);
  if (outcome.result) write("patch.json", outcome.result);
  write("trace.txt", `${trace.join("\n")}\n`);
  say(`存在 ${args.save}`);
}
if (outcome.error) process.exit(1);
