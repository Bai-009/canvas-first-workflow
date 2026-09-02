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

四个角色里，目前做出来并在真模型上验证过的是 Plan Agent 和它的 Gate。Execution Agent 和状态机还是设计稿。

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
| Plan Gate `src/validate-plan-proposal.mjs` | 有，测试守着 |
| Plan Agent 系统提示词 `prompts/plan-agent.md` | 有，中文原文加英文译本 |
| 提交工具与调用循环 `src/plan-agent.mjs` | 有。任何 OpenAI 兼容接口都能接，目前只在 DeepSeek 上跑过 |
| Plan 阶段的多轮会话 `src/plan-session.mjs` | 有。攒对话记录，方案只在过闸时换，回合制，能停 |
| 真模型验证 | 有。deepseek-v4-pro 上跑过三个场景、三次修订轮，原始输出和完整对话记录在 `fixtures/observed/`，行为记录在 `docs/观察.md` |
| 画布原型 `prototype/` | 有。Plan 阶段的内容是真实模型输出，执行阶段是手写的愿景演示 |
| Execution Agent 的输出契约与画布侧 Gate | 没有 |
| 状态机 | 没有 |

所以现在这个仓库是：**设计者这一半做出来了，在真模型上验过；执行者那一半还是设计稿，画布上那段生长是演的。**

## 原型里哪些是真的

原型是一个静态页面，不调用模型。它演的是一次完整的交互：用户打一句话，Plan 卡片长出理解、路线和待确认，用户补一句，卡片原地更新，然后画布上长出工作流。

- 打字之后到「开始生成」之前，卡片上的每一个字都是真的。它们来自 deepseek-v4-pro 提交、Gate 放行的两份方案（`fixtures/observed/run4-*`），由 `src/build-demo-data.mjs` 生成成 `prototype/plan-data.js`。哪些问题被答掉、哪一步原地改，是拿两份方案的编号差异算出来的，不是手标的。
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

校验一份方案文件：

```bash
node src/validate-plan-proposal.mjs fixtures/observed/run1-合同场景.plan.json
```

看原型：用任意静态服务器打开 `prototype/index.html`。改了 `fixtures/observed/` 里的修订轮方案之后，重新生成演示数据：

```bash
node src/build-demo-data.mjs
```

## 怎么读

按这个顺序，一小时能看完：

1. [docs/取舍.md](docs/取舍.md)：每一条契约决定是被什么麻烦逼出来的，放弃了哪条路。
2. [prompts/plan-agent.md](prompts/plan-agent.md) 和 [contracts/plan-proposal.schema.json](contracts/plan-proposal.schema.json)：设计者被要求做什么，交出来的东西长什么样。
3. [docs/观察.md](docs/观察.md) 和 `fixtures/observed/`：真模型实际做了什么，哪些成立，哪些裁定不是问题。
4. [docs/架构.md](docs/架构.md)：四个角色的完整设计，包括还没做的执行者和状态机。
5. `prototype/`：看一遍演示，再看 [prototype/修改本.md](prototype/修改本.md) 里每一处改动的为什么。

## 目录

```
contracts/   契约。目前只有 PlanProposal
prompts/     Plan Agent 的系统提示词，中文原文与英文译本
src/         Gate、提交工具定义、厂商中立的调用循环、Plan 会话与多轮命令、演示数据生成
test/        Gate、工具定义、调用循环的测试
fixtures/    手写的设计样例，以及 observed/ 里真模型的原始输出
docs/
  assets/      README 里的架构总览图，src/ 是它的网页源文件
  取舍.md      每一刀背后的麻烦与放弃的路
  架构.md      四个角色、两段主链路、裁决点
  状态机.md    回合制、账本、执行阶段的七条规则和待确认的洞
  plan-契约.md PlanProposal 各字段为什么长这样
  观察.md      真模型的行为记录
  词表.md      我们的说法和代码里、行业里说法的对照
  设计记录.md  建造过程的逐步记录，早期稿，以上面几份为准
  scenarios/   场景预演，早期稿
prototype/   画布原型，修改本.md 记着每一处改动
scripts/     render-figures.sh：用 Chrome 把 docs/assets/src 里的网页渲染成 2 倍 PNG
AGENTS.md    人和 Agent 在这个仓库里怎么协作
```
