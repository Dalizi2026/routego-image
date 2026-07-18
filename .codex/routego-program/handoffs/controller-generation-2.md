# Program Controller generation 2 交接清单

- 来源 Controller：`019f715f-c042-7590-a38b-ffb406315903`，generation 1。
- 继任 Controller：`pending`，generation 2。
- 计划分支：`codex/routego-controller-g2`。
- 来源 worktree：`C:\Users\MLTZ\.codex\worktrees\d46b\生图插件`。
- 来源可观察压缩：`3`。
- 交接原因：Controller 已达到第 3 次可观察压缩，必须交给全新任务和新 worktree；下一个原子工作是 Library 独立复验、合并、规格同步、归档和主线全量验证。

## 已冻结基线

- Creation 已合并、同步、归档：delivery `624e7390b902814620d3eeb583ed43a57fd8243a`，merge `ebe5b564c3990fa89f5616b636aab0ce053b144a`，archive `d03389ec108bcfd9e79ed076048e50b430900028`。
- Library 已完成 10/10：branch `codex/routego-library-g2`，delivery `fd62a90dc1899ab9d0c993b7192da910e2fa4914`，task state `514db95441d389999bd6341f335aeaaca1cba226`，verified head `341a2fe7d2cfe82ca4a9ac315423071c6911701d`。
- Library 已报告 frozen install、OpenSpec strict 7/7、safety、typecheck、build、327 tests、七包 exports、native/runtime、平台、安全、范围和规划一致性全部通过；Controller 尚未独立复验、合并、同步或归档。
- Studio 当前任务：thread `019f7245-f614-7911-9ea1-c974cd82fa35`，branch `codex/routego-studio-g2`，checkpoint `ec5ce6992bc22477ffda96d12762e4e23a010ec6`，OpenSpec 8/11，task 5.1 in progress，observableCompactions 2。只允许完成 5.1；在 6.1 前必须创建 Studio successor/new worktree。
- 自动监控：`routego-lane-continuity-monitor`，15 分钟，ACTIVE，动态读取 program.json dispatch。

## 继任启动顺序

1. 完整读取 `routego-image-1.0-plan.md`、`AGENTS.md`、`program.json`、`controller.json`、`library.json`、`studio.json`、本交接文件、PD-002/003/004，以及 Library change 的 proposal/design/三份 specs/tasks 和六份主规格。
2. 核对 Controller lane、角色、worktree、分支、起始 commit、Git clean，以及 Library/Studio 的真实线程和完整 SHA。
3. 首轮只读；等待 `[CONTROLLER_SUCCESSOR_REGISTERED]` 后纳入真实 registration commit，创建 `codex/routego-controller-g2`，再发送 `[CONTROLLER_HANDOFF_ACCEPTED]`。
4. G1 收到接管确认后才归档。G2 接管前不得执行 Library merge、spec sync、archive 或创建 Integration。
5. 接管后先独立验证 Library delivery `fd62a90dc1899ab9d0c993b7192da910e2fa4914`，检查 exact diff/scope/commits/tests，再合并；同步三份 Library delta specs，归档 change，并在主线运行完整冻结验证。
6. Library 完成合并归档后仍不得创建 Integration；继续等待 Studio 完成、合并、同步和归档。
7. Studio 5.1 完成时按其 compaction-2 checkpoint 创建新的 Studio successor，再允许 6.1。

## 不可违反的约束

- Controller 只做治理、独立验证、合并、规格同步、归档和调度，不写三条泳道产品代码。
- 不修改七个公共 MCP 工具，不改变冻结产品范围或泳道所有权。
- 不接触真实 API Key、用户图片、真实图库或真实中转，不执行部署、发布或付费请求。
- 同一 change 始终只有一个 apply-owner；Integration 只能在 Creation、Library、Studio 全部合并同步归档后创建。
