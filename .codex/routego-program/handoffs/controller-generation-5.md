# Program Controller generation 5 交接清单

- 来源 Controller task：`019f73d0-1bf4-73c2-8ca9-e28370d34595`，generation 4。
- 来源 worktree：`C:\Users\MLTZ\.codex\worktrees\1756\生图插件`。
- 来源分支：`codex/routego-controller-g4`。
- 来源可观测压缩：`4`，PD-006 预交接状态。
- 继任 Controller task：`019f751c-75c3-7e52-9af1-28db9dad4463`。
- 继任 worktree：`C:\Users\MLTZ\.codex\worktrees\5106\生图插件`。
- 计划继任分支：`codex/routego-controller-g5`。
- 权威交接提交：`01186e733b7ec6f63785ddd4e9b6aa1128f03462`。
- Registration 提交：本次登记提交；真实 SHA 由 `[CONTROLLER_SUCCESSOR_REGISTERED]` 提供。
- 交接原因：Controller G4 与 Integration G2 均到第 4 次可观测压缩。任务 3.1 已完成独立验收，下一项 3.2 是新的大型原子任务，必须先完成 Controller G5 接管，再由 G5 注册和激活 Integration G3。

## Integration 当前冻结状态

- 当前唯一 apply owner：Integration generation 2 task `019f743d-a9e1-7752-b797-c0af436183ab`。
- worktree：`C:\Users\MLTZ\.codex\worktrees\83b9\生图插件`。
- branch：`codex/routego-integration-g2`。
- clean HEAD：`d974cb0d16b7e14ca0766392c7d52356b4967d3c`。
- OpenSpec：`11/29`；已完成并由 Controller 接受 `1.1-1.5`、`2.1-2.5`、`3.1`。
- 下一任务：`3.2`，严格锁定；不得读取其实现范围后开始编辑、暂存或提交。
- G2 observableCompactions=`4`，只允许准备 `.codex/routego-program/handoffs/integration-generation-3.md` 与更新 `integration.json`；不得修改产品或 OpenSpec。
- G2 的最终 3.1 修正链：原实现 `d952c533be007ea54a6f836ea0e8bcfb6f9be510`；精确能力证明 `69fbc5b1c2c3ccecdf853971f4c86c84383f5362`；PNG 预解码边界 `0e3764d92e47cb1df31d07a5ff7c0821ae709b3b`；8 位非交错解码器配置 `f7196e3f77a7aaed59e9ea4390e4655066b3e584`；最终 task-state `9e8ec8463196e5f34b07b4372ed61787ffa44c39`；最终 thread-state `d974cb0d16b7e14ca0766392c7d52356b4967d3c`。
- 独立验收：Integration 72/72、Integration typecheck、依赖顺序 build、repository safety 405、OpenSpec strict 19/19、精确提交链/范围、Git clean 全部通过。

## Controller G5 强制启动顺序

1. 第一轮严格只读，依次完整读取 `routego-image-1.0-plan.md`、`AGENTS.md`、`.codex/routego-program/program.json`、`.codex/routego-program/threads/controller.json`、本交接文件、`.codex/routego-program/threads/integration.json`、PD-002/003/004/005/006/007、Integration change 的 proposal/design/全部 11 delta specs/tasks、全部 18 份 main specs，以及 Creation/Library/Studio 三个 archived change 的 proposal/design/全部 delta specs/tasks。
2. 核对 lane、role、真实 task ID、worktree、detached/branch 状态、交接提交、Git clean，以及 Integration G2 的任务、worktree、branch、最终 HEAD、OpenSpec 11/29、任务 3.1 完成和任务 3.2 锁定状态。
3. 独立核对任务 3.1 的全部修正链和精确范围，确认最终实现只在 `packages/integration/src/provider/probes.ts` 与 `packages/integration/test/provider.test.ts`，后续 task-state/thread-state 各自单文件提交。
4. 核对 `routego-program-continuity` 为 ACTIVE、每 15 分钟、动态解析 program.json 当前 Controller、以 `integrationReadiness.lastDirectCheckpoint` 去重并归档自身完成的运行任务；它只是漏报兜底。
5. `successorThreadId=pending` 是合法等待状态。在 G4 发来真实 `[CONTROLLER_SUCCESSOR_REGISTERED]` 与 registration commit 前，不得切换分支、修改文件、激活 Controller 权威、创建 Integration G3、解锁 3.2、合并、归档、部署或发布。
6. 收到 registration 后纳入提交，创建/切换 `codex/routego-controller-g5`，确认 Git clean；然后真实 `send_message_to_thread` 向 G4 发送 `[CONTROLLER_HANDOFF_ACCEPTED]`，包含真实 task/worktree/branch、handoff/registration SHA、全部核验结果和双路径回报契约确认，并调用 `read_thread` 回读确认。
7. 等待 G4 的 activation governance commit，纳入并确认 program/controller 权威状态与 Git clean。只有 G5 成为 authoritative Controller 后，才可根据 G2 的完整 generation-3 handoff 注册 Integration G3；不得直接激活 G2 或开始 3.2。
8. G5 注册 Integration G3 时，必须要求 G3 完成全量只读接管、真实回传/回读 handoff acceptance；G2 在该确认前不得归档，G3 不得成为唯一 apply owner。G2 归档后再提交 sole-owner activation，且只解锁任务 3.2。

## 双路径回报契约

- 主链：当前 Integration apply owner 每完成 OpenSpec 任务、任务组、安全 checkpoint、阻塞、偏差、交接、activation 或 delivery，立即真实 `send_message_to_thread` 到 program.json 当前 Controller，并调用 `read_thread` 确认送达。
- 兜底链：`routego-program-continuity` 每 15 分钟只检查漏报，以 `integrationReadiness.lastDirectCheckpoint` 去重，并归档自身完成的运行任务；它不是主完成渠道。
- Controller G5 与 Integration G3 的创建提示、registration、handoff acceptance、controller/sole-owner activation 都必须重复并明确确认本契约。不得假设 heartbeat 自动继承；final 标签不算送达。

## 持续安全边界

- Controller 只做治理、独立验证、合并、规格同步、归档、监控和调度，不代写 Integration 产品代码或 OpenSpec 工件。
- 不改变七个公共 MCP 工具或公共 `ImageArtifact.phase=partial|final`。
- 不接触真实 API Key、Authorization、用户图片、真实 Library/relay；不执行 billable probe/request、安装替换、marketplace、部署、发布、迁移、删除或 release。
- Integration 任务 `7.2`、`8.2`、`9.1` 仍需新的用户明确批准。
