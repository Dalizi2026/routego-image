# Program Controller generation 3 交接清单

- 来源 Controller：`019f728e-0b4d-7552-b03a-7ca53eb9c0ae`，generation 2。
- 继任 Controller：`pending`，generation 3。
- 计划分支：`codex/routego-controller-g3`。
- 来源 worktree：`C:\Users\MLTZ\.codex\worktrees\5b80\生图插件`。
- 来源分支：`codex/routego-controller-g2`。
- 来源可观察压缩：`3`。
- 交接前已纳入的 Integration 接管提交：`4e0a31b192a4b51a56c90c6475b11d4d094a3013`。
- 交接原因：Controller G2 已达到第 3 次可观察上下文压缩，必须在启动 Integration 规划或其他大型治理工作前交给全新顶层任务和新 worktree。

## 已完成并冻结的功能泳道

- Creation 已合并、同步、归档：delivery `624e7390b902814620d3eeb583ed43a57fd8243a`，merge `ebe5b564c3990fa89f5616b636aab0ce053b144a`，spec sync `86214f666e10e080f6f4ac419d99402f282ef46e`，archive `d03389ec108bcfd9e79ed076048e50b430900028`。
- Library 最终 delivery `96fea3b5618808fd00daac274178512daf2a5ff2` 已独立复验、合并、同步三份规格并归档：merge `c7ee16a6bca371e656ce11253c31636f7f05e9d1`，spec sync `a9875ed368324b03941893a1ab994b3ff039a499`，archive `50141def268015579febee067c311aa09aaf117f`。
- Studio delivery `ef7dc14df9a1fd58566faa92334a1697d9ab2589` 已独立复验、合并、同步五份规格并归档：merge `987fd2207fde599be85b5dc64b039fb09f500e61`，spec sync `93b8e92267e91edf16e33c7d36e77965f55724e4`，archive `5612c2b2c7a5491a5ab8c94b3e1ac918c4db45fb`。
- 最终功能泳道冻结基线通过：OpenSpec strict 18/18、仓库安全 367 个跟踪文件、全仓 typecheck/build、493 项测试、七包导出、Playwright 6/6 与核心旅程重复 1/1、七个公共操作和工具名冻结、三泳道归档规格一致性、运行时/native、浏览器、秘密/路径和 Git clean 审计。
- `routego-lane-continuity-monitor` 已在 Creation、Library、Studio 全部完成后删除；两个验证副本只残留无文件的 pnpm 空目录，已取消 worktree 登记，属于非产品且非阻塞残留，不再递归清理。

## Integration 当前权威状态

- 任务：`019f72fd-fb6f-7b52-b383-03471f42f05a`。
- worktree：`C:\Users\MLTZ\.codex\worktrees\4687\生图插件`。
- 分支：`codex/routego-integration`。
- starting commit：`5afdec25e3c8b318d46e11ca73517bd2b21f924b`。
- Controller registration commit：`dd3a601e00e320399d65ccc71fd3932fda0107e1`。
- Integration handoff acceptance commit：`4e0a31b192a4b51a56c90c6475b11d4d094a3013`。
- Integration 已完整读取计划、AGENTS、program、Integration 状态、PD-002/003/004、18 份主规格及 Creation/Library/Studio 三个归档 change，并核验干净分支与精确提交。
- `openspec/changes/integrate-routego-image-plugin` 目前故意不存在，这是已授权的 proposal 起点。Integration 尚未创建 proposal/design/delta specs/tasks，也未修改产品代码。
- G3 接管并完成独立核验前，不向 Integration 发送 apply 授权。G3 首先只能发送“使用 openspec-propose 创建并严格验证完整规划工件”的阶段激活；收到 `[INTEGRATION_PLAN_READY]` 后由 Controller 独立审查，再决定是否允许 apply。

## G3 强制启动顺序

1. 依次完整读取 `routego-image-1.0-plan.md`、`AGENTS.md`、`.codex/routego-program/program.json`、`.codex/routego-program/threads/controller.json`、`.codex/routego-program/threads/integration.json`、本交接文件、PD-002/003/004、全部 18 份 `openspec/specs/*/spec.md`，以及 Creation/Library/Studio 三个归档 change 的 proposal、design、全部 delta specs 和 tasks。
2. 核对 lane、role、真实 thread ID、worktree、detached/branch 状态、起始 commit、Git clean，并核对 Integration 真实线程、worktree、分支及上述完整 SHA。
3. `successorThreadId: pending` 属合法状态。第一轮只读审计；不得激活 Integration、创建或修改 Integration OpenSpec、修改产品代码、合并、归档、部署或发布。
4. 等待 G2 发来 `[CONTROLLER_SUCCESSOR_REGISTERED]`，纳入真实 registration commit，创建/切换到 `codex/routego-controller-g3` 并确认 Git clean。
5. 接管信息准确后，向 G2 `019f728e-0b4d-7552-b03a-7ca53eb9c0ae` 发送结构化 `[CONTROLLER_HANDOFF_ACCEPTED]`，包含真实 thread ID、worktree、branch、starting commit、registration commit、核验结果和下一步。G2 收到前不得归档。
6. 等待 G2 发来 activation governance commit，将其纳入 G3 分支并再次确认 Git clean；然后才可向 Integration 发送仅 proposal 阶段的结构化激活消息。

## 不可违反的约束

- Controller 只做治理、独立验证、合并、规格同步、归档、监控和调度，不代写 Integration 产品代码或 OpenSpec 规划工件。
- 不增加、删除或重命名七个公共 MCP 工具，不改变已冻结的 18 份主规格，除非先收到并审批明确的 `[PLAN_DEVIATION]`。
- 不使用真实 API Key、Authorization、用户图片、真实图库或真实中转；不执行部署、发布、marketplace 替换、付费 probe、billable 请求或破坏性数据迁移。
- Integration 在 proposal 审批前不得 apply；proposal 审批也不构成真实凭证、真实数据、部署、发布或付费请求授权。
