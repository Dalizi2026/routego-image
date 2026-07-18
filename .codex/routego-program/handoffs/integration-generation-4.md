# Integration generation 4 低上下文交接入口

权威机器胶囊：`.codex/routego-program/handoffs/integration-generation-4.capsule.json`

当前状态：

- source：Integration G3 task `019f7557-3836-7822-82ab-1e850e4cf157`
- source worktree：`C:\Users\MLTZ\.codex\worktrees\1b58\生图插件`
- source branch：`codex/routego-integration-g3`
- source handoff：`fcc0a8e6a0e276bb7d267d6dc2502a9c2b9520bc`
- accepted task 3.4 implementation：`17208da376f71790561ae87e3d59b77287765b3b`
- successor：Integration G4 task/worktree `pending`
- planned branch：`codex/routego-integration-g4`
- OpenSpec：14/29，next `3.5` locked
- 当前 task capsule：`.codex/routego-program/tasks/integration-3.5.json`
- G3 保持冻结 sole apply owner；G4 在 acceptance 与显式 sole-owner activation 前没有 apply 权限

G3 在任务 3.4 完成后、3.5 激活前出现第 3 次可观测压缩，因此 3.5 不得在 G3 启动。G4 acceptance 前若出现任何可观测压缩，必须发送 `HANDOFF_CONTEXT_BUDGET_FAILED` 并拒绝激活。

直接 `send_message_to_thread` 后 `read_thread` 回读是主链；30 分钟自动化只做漏报兜底。G4 接管确认、G3 归档与 G4 sole-owner activation 必须重复确认该契约。
