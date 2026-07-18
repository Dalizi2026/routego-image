# Program Controller generation 4 交接清单

- 来源 Controller task：`019f7309-d473-74a2-934b-e81726d90a31`，generation 3。
- 继任 Controller task：`019f73d0-1bf4-73c2-8ca9-e28370d34595`，generation 4。
- 继任 worktree：`C:\Users\MLTZ\.codex\worktrees\1756\生图插件`。
- 来源 worktree：`C:\Users\MLTZ\.codex\worktrees\0c1f\生图插件`。
- 来源分支：`codex/routego-controller-g3`。
- 计划继任分支：`codex/routego-controller-g4`。
- 权威交接提交：`e8b96e3685b939843d9029657bd2108116a38b03`。
- Registration 提交：`c292c2d461ed33000d7f154edba04908f36eedce`。
- 接管状态：G4 已在 clean `codex/routego-controller-g4` HEAD `c292c2d461ed33000d7f154edba04908f36eedce` 完成全部权威、Integration、自动化与 Git 审计，并通过真实消息向 G3 回传 `[CONTROLLER_HANDOFF_ACCEPTED]`；G3 已用 `read_thread` 回读确认。
- 双路径确认：G4 明确承诺直接 `send_message_to_thread` + `read_thread` 是主链，`routego-program-continuity` 是 10 分钟项目级漏报兜底，后续任何 Controller/Integration successor 都必须在创建、登记、接受和激活时继承此契约。
- 交接原因：Controller G3 在收到 Integration 任务 1.4 后出现新的明确模型上下文摘要，达到第 3 次可观测压缩。按健康协议，必须在授权大型任务 2.1 前交给全新顶层任务和新 worktree。

## Integration 当前权威状态

- 唯一 apply owner：Integration generation 1 task `019f737f-80f3-7cd2-a6c7-aaec1f017d8d`。
- worktree：`C:\Users\MLTZ\.codex\worktrees\5b94\生图插件`。
- 分支：`codex/routego-integration-g1`。
- clean HEAD：`0223dfbe7ee4e3683c1c63044246a318a5afc053`。
- OpenSpec：`4/28`；已完成 `1.1`、`1.2`、`1.3`、`1.4`；下一任务 `2.1`，尚未开始。
- 任务 1.4 实现提交：`34956e46182d7df8d7b5a6af98659ab2bb68f658`；task-state 提交：`b54f8dcbc8f36fbb967e14b56b643ef9e25e590d`；线程状态提交：`0223dfbe7ee4e3683c1c63044246a318a5afc053`。
- Controller G3 已独立核对：实现与 task-state 血缘可达；实现只修改 `packages/studio/src/features/library/handoff.ts` 和 `packages/studio/test/library-handoff.test.ts`；fresh apply 指令为 `4/28`、下一任务 `2.1`；OpenSpec strict `19/19`；两边 Git clean。
- Integration generation 1 仍是唯一 offline apply owner，但在 Controller G4 接受交接并由 G3 激活前，任务 2.1 必须保持停止。

## 双路径连续性契约

- 主链：Integration 每完成 OpenSpec 任务、任务组、安全 checkpoint、阻塞、偏差、交接、激活或交付，必须立即调用真实 `send_message_to_thread` 向 `program.json` 当前 `controllerThreadId` 回传结构化消息，再调用 `read_thread` 确认进入目标 task；final 标签或等待自动化不算送达。
- 兜底链：项目级自动化 `routego-program-continuity` 每 10 分钟运行，动态读取当前 Controller task ID，仅检查漏报并对照 `integrationReadiness.lastDirectCheckpoint` 去重；它不是绑定 G3 的 heartbeat，也不是正常完成通知渠道。
- G4 的 task 创建提示、registration、handoff acceptance 和 activation governance 必须重复写明并明确确认此契约。G4 未确认前，G3 不得归档，G4 不得成为权威 Controller，Integration 不得开始 2.1。

## G4 强制启动顺序

1. 依次完整读取 `routego-image-1.0-plan.md`、`AGENTS.md`、`.codex/routego-program/program.json`、`.codex/routego-program/threads/controller.json`、本交接文件、Integration thread state、PD-002/003/004/005、Integration proposal/design/11 delta specs/tasks、全部 18 份主规格及 Creation/Library/Studio 三个归档 change。
2. 第一轮只读核对真实 task ID、worktree、detached/branch 状态、交接 commit、Controller Git clean、Integration 上述精确 HEAD/血缘/4/28/下一任务 2.1/Git clean，以及自动化 `routego-program-continuity` 的 ACTIVE 项目级状态。
3. `successorThreadId=pending` 合法。等待 G3 发来 `[CONTROLLER_SUCCESSOR_REGISTERED]`，纳入 registration commit，创建/切换 `codex/routego-controller-g4`，确认 Git clean。
4. 使用真实 `send_message_to_thread` 向 G3 回传 `[CONTROLLER_HANDOFF_ACCEPTED]`，包含真实 task/worktree/branch、handoff/registration SHA、权威核验和对双路径回报契约的明确确认；随后调用 `read_thread` 确认送达。
5. 等待 G3 提交并发送 activation governance commit。G4 纳入该提交并确认 authoritative Controller 状态与 Git clean 后，才可向 Integration 发送只解锁任务 2.1 的结构化 follow-up；必须要求 Integration 完成 2.1 后直接回传并 read-back。

## 不可违反的约束

- Controller 只做治理、独立验证、合并、规格同步、归档、监控和调度，不代写 Integration 产品代码或 OpenSpec 工件。
- 不增加、删除或重命名七个公共 MCP 工具；公共 `ImageArtifact.phase` 保持 `partial | final`；17+12+4=33 图结构、唯一认证流路由和会话封顶资源寿命保持冻结。
- 不使用真实 API Key、Authorization、用户图片、真实图库或真实中转；不执行 billable probe/request、安装替换、marketplace 修改、部署、发布、迁移、删除或 release。
- Integration 任务 `7.2`、`8.2`、`9.1` 仍需新的用户明确批准与真实前置门禁，Controller apply 调度不得推断外部授权。
