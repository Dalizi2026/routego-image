# Integration generation 4 低上下文交接入口

权威机器胶囊：`.codex/routego-program/handoffs/integration-generation-4.capsule.json`

当前状态：

- source：Integration G3 task `019f7557-3836-7822-82ab-1e850e4cf157`
- source worktree：`C:\Users\MLTZ\.codex\worktrees\1b58\生图插件`
- source branch：`codex/routego-integration-g3`
- source handoff：`fcc0a8e6a0e276bb7d267d6dc2502a9c2b9520bc`
- accepted task 3.4 implementation：`17208da376f71790561ae87e3d59b77287765b3b`
- successor：Integration G4 task `019f7633-a831-7b62-a00a-d4b6fba5515e`
- successor worktree：`C:\Users\MLTZ\.codex\worktrees\a818\生图插件`
- branch：`codex/routego-integration-g4`
- accepted incorporation：`ec97b7f97b9768ca586480d4c7e99be81015196c`
- OpenSpec：14/29，next `3.5` unlocked but not started
- 当前 task capsule：`.codex/routego-program/tasks/integration-3.5.json`
- G3 已由 Controller 归档并撤销 apply owner；G4 已成为唯一 apply owner，纳入显式 activation 后只能开始任务 3.5

G4 已在 acceptance 前保持零次可观测压缩，按 capsule 顺序读取 12 个文件（规范化 UTF-8 共 98064 字节），验证器通过且 Git clean。G3 归档前的第 4 次压缩发生在冻结源任务中，不影响已完成的 G4 接管审计。

直接 `send_message_to_thread` 后 `read_thread` 回读是主链；30 分钟自动化只做漏报兜底。G4 纳入 sole-owner activation 后必须再次真实回报并回读确认，随后才可读取 apply skill 和开始 3.5。
