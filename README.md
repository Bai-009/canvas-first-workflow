# Canvas-first Workflow

如果你需要一条可视化工作流来处理数据，你想用 AI 把它建出来，而不是手动拖拽。

问题在于：绝大多数 AI 产品的交互都发生在对话框里，而工作流是一条画布——它不是一份文件，也不是一段文字。

**什么样的架构，才能让 AI 的输出变成一条生长中的工作流，而不是长在对话框里的东西。**

这个仓库是对这个问题的回答：一份架构设计，加一个能看见的原型。

## 要做出来的是什么

一条工作流在你眼前长出来，你随手就能改它。

后端裁定、契约、Gate、节点骨架、乐观并发——所有这些都是为这件事服务的，不是它本身。

## 架构一句话

> Plan Agent 定义一条数据链路「应该完成什么、怎样才算完整」；Execution Agent 根据平台真实能力决定「具体用什么、怎么把它做出来」。状态机负责把前者逐步交给后者，并控制整个过程。Gate 决定什么才能成为事实。

展开在 [docs/架构.md](docs/架构.md)：四个角色各自的边界、两段主链路、谁在哪一步做裁决。

## 现在做到哪儿

诚实的进度，不是路线图。

| | 状态 |
|---|---|
| Plan 契约（`contracts/plan-proposal.schema.json`） | 有 |
| Plan Gate（`src/validate-plan-proposal.mjs`） | 有，12 条测试守着 |
| 合同 Query 的 Plan 样例（`fixtures/`） | 有，手写的，还不是模型产出 |
| Plan Agent 的系统提示词与模型调用 | 没有 |
| Execution Agent 的输出契约与画布 Gate | 没有 |
| 状态机 | 没有 |
| 画布原型（`prototype/`） | 有，但数据写死，还没接契约 |

所以现在这个仓库是：**架构想清楚了一半，机制立起了一根柱子，界面能看但还是空转的。**

## 跑一下

```bash
npm test
```

```bash
npm run validate:fixture
```

原型是一个静态页面，用任意静态服务器打开 `prototype/index.html` 即可。

## 目录

```
contracts/   契约。目前只有 PlanProposal
src/         模型之外的确定性校验
test/        Gate 的测试
fixtures/    共同设计用的样例
docs/
  架构.md      四个角色、两段主链路、裁决点
  设计记录.md  建造过程的逐步记录
  plan-契约.md PlanProposal 各字段为什么长这样
  scenarios/   场景预演
prototype/   画布原型
AGENTS.md    人和 Agent 在这个仓库里怎么协作
```
