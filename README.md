# Canvas-first Workflow

如果你需要一条可视化工作流来处理数据，你想用 AI 把它建出来，而不是手动拖拽。

问题在于：绝大多数 AI 产品的交互都发生在对话框里，而工作流是一条画布。它不是一份文件，也不是一段文字。

**什么样的架构，才能让 AI 的输出变成一条生长中的工作流，而不是长在对话框里的东西。**

这个仓库是对这个问题的回答：一份架构设计，一段做出来并在真模型上验证过的机制，加一个能看见的原型。

## 要做出来的是什么

一条工作流在你眼前长出来，你随手就能改它。

契约、Gate、状态机、乐观并发，所有这些都是为这件事服务的，不是它本身。

## 架构一句话

> Plan Agent 定义一条数据链路「应该完成什么、怎样才算完整」；Execution Agent 根据平台真实能力决定「具体用什么、怎么把它做出来」。状态机负责把前者逐步交给后者。Gate 决定什么才能成为事实。

![架构总览：浏览器、工作流生成系统、外部三块；实线框做了，虚线框是设计稿](docs/assets/architecture.png)

四个角色里，做出来并在真模型上验证过的是 Plan Agent 和它的 Gate；状态机也做出来了，测试守着，命令行里按得到。Execution Agent 还没有，状态机上给它留的是一个插口。

Plan Agent 这一段是这么切的：

- **数据形态转变一次，就是一步。** 每一步写清数据进来是什么形态、出去变成什么形态。链路靠「上一环的输出形态逼出下一环」往前推，不是一张动作清单。
- **公有知识放手，私有事实必问。** OCR、切 chunk、数仓分层这类行业通识模型自己会，提示词一个字不教。只存在于用户那边的事实（哪张表、什么口径、抽哪几个字段）必须问，不许用默认值填。判据是：错了用户看不看得出来。
- **方案通过一个工具提交。** 模型在同一条消息里可以先说话再提交。信息不够就只说话不提交，这本身是合法产出，不是失败。
- **Gate 是唯一的保证。** 它以 schema 文件为唯一来源，再加 schema 写不出来的跨字段检查。没过就把错误原样发回让模型重交完整的一份，重试有上限。
- **模型侧只要求 OpenAI 兼容的对话接口。** 不引任何厂商 SDK，换模型只换地址、key、模型名三个配置。
- **每一轮提交完整的一份，不提交增量。** 界面上「原地改还是重来」靠编号：沿用同一个编号就是原地改，换新编号就是这条重来。

每一条背后放弃了什么，在 [docs/取舍.md](docs/取舍.md)。

## 现在做到哪儿

诚实的进度，不是路线图。

| | 状态 |
|---|---|
| Plan 契约 `contracts/plan-proposal.schema.json` | 有 |
| Plan Gate `src/plan/validate-plan-proposal.mjs` | 有，测试守着 |
| Plan Agent 系统提示词 `prompts/plan-agent.md` | 有，中文原文加英文译本 |
| 提交工具与调用循环 `src/plan/plan-agent.mjs` | 有。任何 OpenAI 兼容接口都能接，目前只在 DeepSeek 上跑过 |
| Plan 阶段的多轮会话 `src/plan/plan-session.mjs` | 有。攒对话记录，方案只在过闸时换，回合制，能停 |
| 真模型验证 | 有。deepseek-v4-pro 上跑过三个场景、三次修订轮，原始输出和完整对话记录在 `fixtures/observed/`，行为记录在 `docs/观察.md` |
| 画布原型 `prototype/` | 有。Plan 阶段的内容是真实模型输出，执行阶段是手写的愿景演示 |
| 状态机 `src/state-machine/workflow-session.mjs` | 有。开始、停、批注、走步、画布、每次走步的记录；执行者是插口，`npm run plan:chat` 里 `/start` 按得到 |
| 画布侧 Gate | 一半。机器能查的几条在状态机里（节点标的是哪一步、编号不撞、线接在存在的节点上、走完整张画布查形状）；节点类型对平台目录的检查要等执行者带着目录来 |
| 平台目录与检索工具 `src/executor/n8n-catalog.mjs` | 有。从 n8n 官方镜像导出全部 559 种节点的参数说明（`fixtures/n8n/catalog.json`，脚本可重新导出）。给模型的不是整份目录，是三层披露：常驻十来行、搜索回候选、点名才给参数，分操作的节点先给操作菜单 |
| Execution Agent 与它的输出契约 | 一半。提示词（`prompts/executor.en.md`，英文为主，中文副本待写）、它眼前三个工具的说明、交回的形状的契约（`contracts/step-submission.schema.json`）定了，怎么定的见 `docs/执行者.md`。让模型来回查、看、交的循环还没写，所以还没在真模型上跑过。`fixtures/doubles/fixed-executor.mjs` 是测试用的固定答复，节点类型明写「固定答复(不是真节点)」，只为看状态机怎么动 |

所以现在这个仓库是：**设计者这一半做出来了，在真模型上验过；状态机做出来了，测试守着；执行者本身还没有，画布上那段生长在原型里是演的，在命令行里是固定答复走出来的。**

## 原型里哪些是真的

原型是一个静态页面，不调用模型。它演的是一次完整的交互：用户打一句话，Plan 卡片长出理解、路线和待确认，用户补一句，卡片原地更新，然后画布上长出工作流。

- 打字之后到「开始生成」之前，卡片上的每一个字都是真的。它们来自 deepseek-v4-pro 提交、Gate 放行的两份方案（`fixtures/observed/run4-*`），由 `src/prototype/build-demo-data.mjs` 生成成 `prototype/plan-data.js`。哪些问题被答掉、哪一步原地改，是拿两份方案的编号差异算出来的，不是手标的。
- 「开始生成」之后长出来的六个节点，是手写的愿景演示。节点里的存储路径、字段清单、代码、定时时间都是编的。Execution Agent 还不存在，画布并没有读那份方案。
- 现场出图只能在命令行。画布和命令行之间目前没有连线。

## 跑一下

需要 Node 22.9 以上。

跑测试：

```bash
npm test
```

让真模型出一份方案。先把 `.env.example` 抄成 `.env`，填上接口地址、key、模型名，任何 OpenAI 兼容接口都行：

```bash
npm run plan -- "每天定时把新增的合同 PDF 解析出关键字段，写进数据库"
```

模型要么提交一份过了 Gate 的方案，要么只说话向你提问。两种结果都会原样打出来。

提示词默认用中文版。想试英文译本，在 `.env` 里加一行 `PLAN_PROMPT_LANG=en`。

多轮聊，一行一轮，用户补一句模型就整份重推。加 `--save <目录>` 把每一轮的原始输出和完整对话记录存下来，`fixtures/observed/` 里的实录就是这么来的：

```bash
npm run plan:chat -- --save fixtures/observed/我的一次运行
```

同一个命令行里有三个按钮：`/start` 按开始，状态机从 s1 起一步一步交给执行者；`/note s1 文字` 在 s1 上批注，下次 `/start` 执行者会看到；`/canvas` 看画布。执行者用 `EXECUTOR_MODULE=路径` 插进来（默认导出一个 async 函数）；没插的时候 `/start` 会明说做不了。想看状态机怎么动，插测试用的固定答复：

```bash
EXECUTOR_MODULE=fixtures/doubles/fixed-executor.mjs npm run plan:chat
```

它交回的节点类型明写「固定答复(不是真节点)」，不是执行者。`fixtures/observed/run9-状态机走步-固定答复/` 是这么跑出来的一份记录：真模型出的方案，固定答复走的步。

校验一份方案文件：

```bash
node src/plan/validate-plan-proposal.mjs fixtures/observed/run1-合同场景/turn-1.plan.json
```

看原型：用任意静态服务器打开 `prototype/index.html`。改了 `fixtures/observed/` 里的修订轮方案之后，重新生成演示数据：

```bash
node src/prototype/build-demo-data.mjs
```

## 怎么读

按这个顺序，一小时能看完：

1. [docs/取舍.md](docs/取舍.md)：每一条契约决定是被什么麻烦逼出来的，放弃了哪条路。
2. [prompts/plan-agent.md](prompts/plan-agent.md) 和 [contracts/plan-proposal.schema.json](contracts/plan-proposal.schema.json)：设计者被要求做什么，交出来的东西长什么样。
3. [docs/观察.md](docs/观察.md) 和 `fixtures/observed/`：真模型实际做了什么，哪些成立，哪些裁定不是问题。
4. [docs/架构.md](docs/架构.md)：四个角色的完整设计，包括还没做的执行者和状态机。
5. [docs/执行者.md](docs/执行者.md)：执行者的提示词是怎么一条条推出来的，还没做的部分。
5. `prototype/`：看一遍演示，再看 [prototype/修改本.md](prototype/修改本.md) 里每一处改动的为什么。

## 目录

```
contracts/   契约。目前只有 PlanProposal
prompts/     系统提示词：Plan Agent 中文原文与英文译本；执行者英文为主（中文副本待写）
src/
  plan/          设计者这一半：Gate、提交工具定义、调用循环、方案差异、Plan 会话
  state-machine/ 状态机：从方案里读走步顺序与拼上下文、开始/停/批注/走步/画布/记录
  executor/      执行者这一半：平台目录的搜索与详情、交步的工具定义（循环本体还没写）
  model/         跟模型说话的插座，OpenAI 兼容，两半共用
  cli/           多轮命令 plan:chat
  prototype/     给画布原型生成演示数据
test/        按 src 的目录一一对应
fixtures/    手写的设计样例；observed/ 里真模型的原始输出，一次运行一个文件夹；doubles/ 里测试用的固定答复执行者；n8n/ 里从官方镜像导出的节点目录
docs/
  assets/      README 里的架构总览图，src/ 是它的网页源文件
  取舍.md      每一刀背后的麻烦与放弃的路
  架构.md      四个角色、两段主链路、裁决点
  状态机.md    回合制、账本、执行阶段的七条规则、代码做成了什么、待确认的洞
  执行者.md    提示词是怎么一条条推出来的、行家的写法、还没做的
  plan-契约.md PlanProposal 各字段为什么长这样
  观察.md      真模型的行为记录
  词表.md      我们的说法和代码里、行业里说法的对照
  设计记录.md  建造过程的逐步记录，早期稿，以上面几份为准
  scenarios/   场景预演，早期稿
prototype/   画布原型，修改本.md 记着每一处改动
scripts/     render-figures.sh 出图；dump-n8n-nodes.sh 从 n8n 镜像导出节点说明，trim-n8n-nodes.mjs 精简成目录
AGENTS.md    人和 Agent 在这个仓库里怎么协作
CLAUDE.md    Claude Code 每个会话先读的规矩，指向 AGENTS.md
```
