# Studio generation 1 交接清单

## 身份与交接原因

- 泳道：`studio`
- OpenSpec change：`add-routego-studio`
- 来源任务：`019f7084-180c-7c91-aaa0-c92820ffcac8`
- 来源代次：`0`
- 继任任务：`pending`，创建后以线程登记为准
- 继任代次：`1`
- 计划分支：`codex/routego-studio-g1`
- 可观察上下文压缩：`2`
- 交接原因：来源任务在第二次压缩后完成安全检查点，但剩余任务均为大型原子工作；按治理要求不得让旧任务直接开始 `2.2`，必须使用全新任务和新 worktree 接管。

## 安全基线

- 来源 worktree：`C:\Users\MLTZ\.codex\worktrees\3a7b\生图插件`
- 来源分支：`codex/routego-studio`
- 产品与 OpenSpec 安全提交：`bffe22b43c288bc16ea0c3dae6a4627b5ab5dafb`
- Git 状态：干净
- OpenSpec：`4/11` 完成
- 已完成：`1.1`、`1.2`、`2.1`、`3.1`
- 下一任务：`2.2`
- 剩余：`2.2`、`3.2`、`4.1`、`4.2`、`5.1`、`6.1`、`7.1`

## 独立复验记录

在安全提交上重新执行并通过：

- `openspec status --change add-routego-studio --json`
- `openspec instructions apply --change add-routego-studio --json`
- `pnpm --filter @routego-image/studio typecheck`
- `pnpm --filter @routego-image/studio test`：14 个文件，38 项测试通过
- `pnpm --filter @routego-image/studio build`：tsup 库构建与 Vite 应用构建通过
- `openspec validate add-routego-studio --strict --no-interactive`
- `pnpm safety`：217 个跟踪文件通过
- `git diff --check`
- `git status --short --branch`：干净

## Apply-owner 互斥

- 本交接治理提交形成后，来源任务的 apply 权限暂停，不得继续修改产品代码或 `add-routego-studio` OpenSpec 工件。
- 继任任务在真实线程 ID、worktree、分支和登记提交写入权威状态前只能只读审计。
- 继任任务在任何写入前必须运行两条新鲜命令：
  - `openspec status --change add-routego-studio --json`
  - `openspec instructions apply --change add-routego-studio --json`
- 继任任务确认安全基线、4/11 状态、下一任务 `2.2` 和所有权后，必须向 Program Controller `019f715f-c042-7590-a38b-ffb406315903` 发送结构化 `[STUDIO_HANDOFF_ACCEPTED]`。
- Program Controller 收到接管确认并归档来源任务后，继任任务才成为唯一 apply-owner，且只能从 `2.2` 继续，不得重做已完成任务。

## 防止无声中断

只要 change 未全部完成，任务在输出 final answer 或进入 idle 前必须实际向当前 Controller 发送 `[LANE_CHECKPOINT]`、`[BLOCKED]`、`[PLAN_DEVIATION]`、`[DEPENDENCY_COMPLETE]` 或 `[LANE_COMPLETE]` 之一。不得只在自身 final answer 中请求唤醒。

`[LANE_CHECKPOINT]` 至少包含 lane/change、branch、完整 HEAD、OpenSpec 完成数、已完成和下一任务、Git 清洁状态、最近验证、observableCompactions、停止原因及推荐动作。

第二次可观察压缩必须形成安全提交；下一任务若是大型原子任务，必须请求 Controller 创建 successor。第三次压缩仍强制新任务、新 worktree 交接。

## 不可变范围

- 不改变七个公共 MCP 工具。
- 不假定 Images Edits 或 Responses 存在。
- 不接触真实 API Key、用户图片、真实图库或真实中转。
- Studio 只拥有 React/Vite 页面、组件、遮罩编辑器和浏览器测试；不得实现 Creation、Library、Integration 或发布职责。
- 交接治理不得修改产品 OpenSpec 需求语义。
