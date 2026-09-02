import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { callerFromEnv, loadSystemPrompt } from "./plan-agent.mjs";
import { createPlanSession } from "./plan-session.mjs";

/* 多轮命令:一行一轮。对话记录攒着,过了闸门的方案换成当前方案,
   正在跑的一轮可以 Ctrl-C 停掉(那轮作废,只留你那句)。
   --save <目录> 把每一轮的原始输出和完整对话记录存下来,fixtures/observed/ 里的实录就这么来。
   --lang en 用英文提示词。 */

function parseArgs(argv) {
  const args = { save: null, lang: process.env.PLAN_PROMPT_LANG || "zh" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--save") args.save = argv[++i];
    else if (argv[i] === "--lang") args.lang = argv[++i];
  }
  return args;
}

function mark(diff, section, ref) {
  if (!diff) return "";
  const d = diff[section];
  if (d.added.includes(ref)) return "  ← 新增";
  if (d.changed.includes(ref)) return "  ← 原地改";
  return "";
}

function render(plan, diff, revision) {
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

function save(dir, session, turnNumber, turn) {
  writeFileSync(join(dir, "transcript.json"), `${JSON.stringify(session.transcript, null, 2)}\n`);
  if (turn.plan) {
    writeFileSync(join(dir, `turn-${turnNumber}.plan.json`), `${JSON.stringify(turn.plan, null, 2)}\n`);
  }
  if (turn.speech) writeFileSync(join(dir, `turn-${turnNumber}.speech.txt`), `${turn.speech}\n`);
}

/* 终端里一问一答;管道进来的(比如脚本喂两行)先整个读完再逐行跑,
   否则模型在推的时候到达的那几行没人接,会被 readline 丢掉。 */
async function* lines(rl) {
  if (input.isTTY) {
    for (;;) {
      try {
        yield await rl.question("\n你:");
      } catch {
        return;
      }
    }
  }
  const queued = [];
  for await (const line of rl) queued.push(line);
  for (const line of queued) {
    output.write(`\n你:${line}\n`);
    yield line;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let callModel;
  try {
    callModel = callerFromEnv();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const session = createPlanSession({ callModel, systemPrompt: loadSystemPrompt(args.lang) });
  if (args.save) mkdirSync(args.save, { recursive: true });

  const rl = readline.createInterface({ input, output });
  const onInterrupt = () => {
    if (session.stop()) {
      output.write("\n（已停止,这轮作废,只留下你那句。）\n");
      return;
    }
    output.write("\n再见。\n");
    process.exit(0);
  };
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);

  console.log("一行一轮。正在跑的时候 Ctrl-C 停掉这一轮;没在跑的时候 Ctrl-C 退出。");
  let turnNumber = 0;
  for await (const line of lines(rl)) {
    const text = (line ?? "").trim();
    if (!text) continue;
    turnNumber += 1;
    output.write("…模型在推\n");
    let turn;
    try {
      turn = await session.say(text);
    } catch (error) {
      if (error.name !== "AbortError") console.error(`这轮失败:${error.message}`);
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
