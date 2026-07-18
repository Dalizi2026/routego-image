# PD-006：全角色上下文交接阈值调整

- Status: accepted by explicit user direction; effective immediately for all roles
- Scope: Program Controller、Foundation、Creation、Library、Studio、Integration 及其 successor/subagent 线程
- Decision date: 2026-07-18

## Finding

完整交接清单本身会消耗接近一次上下文压缩。原先第 3 次可观测压缩就强制创建新线程，容易在新线程刚完成权威重读后再次接近容量上限，降低连续开发效率。

## Decision

将强制新线程/新 worktree 的阈值从第 3 次调整为第 5 次。该规则不是简单延后安全措施，而是增加两个中间门禁：

1. 第 1～2 次：记录事件指纹并完成健康审计；只有审计通过才继续。
2. 第 3 次：必须建立 Git 安全检查点；完成当前小型/原子边界后重新审计，不开始新的大型原子任务。
3. 第 4 次：进入预交接状态；只允许完成当前已开始的原子任务和交接准备，不得启动新的大型任务。
4. 第 5 次：只要仍有未完成工作，必须创建全新 Codex 任务和新 worktree。

健康审计失败、无法确认权威状态或其他高风险外部条件时，仍可提前交接。该阈值适用于所有角色，不改变历史交接事实；历史文件中“第 3 次触发交接”的记录仅描述当时规则下发生的事件。

## Required updates

- 全局计划、AGENTS、program 状态和项目级连续性自动化必须使用第 3 次检查点、第 4 次预交接、第 5 次强制交接。
- 每个 successor 的创建提示、registration、handoff acceptance 和 sole-owner/controller activation 继续继承双路径回报契约。
- 验证覆盖从“模拟三次压缩”更新为“模拟五次压缩”，并覆盖第 3、4、5 次门禁行为。
- PD-008 生效后，健康审计和 successor 启动使用紧凑权威摘要、当前状态、capsule 和定向 evidence；不再默认全量读取全部主规格与归档 change。压缩阈值本身不变。

## Non-goals

- 不改变任何产品功能、公共 MCP 工具、公共 `ImageArtifact.phase`、OpenSpec 产品任务顺序或外部授权边界。
- 不倒改已归档交接记录，不因此重做已经完成的产品任务。
