# Integration generation 3 低上下文交接入口

权威机器胶囊：`.codex/routego-program/handoffs/integration-generation-3.capsule.json`

当前状态：

- source：Integration G2 task `019f743d-a9e1-7752-b797-c0af436183ab`
- successor：Integration G3 task `019f7557-3836-7822-82ab-1e850e4cf157`
- successor worktree：`C:\Users\MLTZ\.codex\worktrees\1b58\生图插件`
- successor branch：`codex/routego-integration-g3`
- source handoff：`3f1878bbe2e5dc2680b92422a43160bc1cac8802`
- registration：`3741896e20154699eaec0417a5ef511b4e71c73b`
- accepted product：`d974cb0d16b7e14ca0766392c7d52356b4967d3c`
- OpenSpec：11/29，next `3.2`
- G2 仍是冻结的唯一 apply owner；G3 已登记但未接受、未激活；3.2 锁定
- 当前 task capsule：`.codex/routego-program/tasks/integration-3.2.json`
- 完成任务 evidence：`.codex/routego-program/evidence/integration-generation-2-tasks.json`
- 旧完整交接原文：commit `428c1a904299f7043feb3fd08d5c0265f3098243` 中本路径，SHA-256 `ca13ad7277ab712e3b1f0d889b9b3f0e50d2aa6b1dd66e52875336acc452bfbb`

G3 只读取 capsule 的 mandatoryFiles，最多 12 个文件、120 KiB。acceptance 前若发生一次上下文压缩，发送 `HANDOFF_CONTEXT_BUDGET_FAILED` 并停止；验证器失败发送 `HANDOFF_AUDIT_FAILED`。

直接 `send_message_to_thread` 后 `read_thread` 回读是主链；30 分钟自动化只做漏报兜底。G3 接受前不得归档 G2，G2 归档和显式 sole-owner activation 前不得开始 3.2。
