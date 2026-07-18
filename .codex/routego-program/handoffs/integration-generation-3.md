# Integration generation 3 低上下文交接入口

权威机器胶囊：`.codex/routego-program/handoffs/integration-generation-3.capsule.json`

当前状态：

- source：Integration G2 task `019f743d-a9e1-7752-b797-c0af436183ab`
- successor：Integration G3 task `019f7557-3836-7822-82ab-1e850e4cf157`
- successor worktree：`C:\Users\MLTZ\.codex\worktrees\1b58\生图插件`
- successor branch：`codex/routego-integration-g3`
- source handoff：`3f1878bbe2e5dc2680b92422a43160bc1cac8802`
- registration：`3741896e20154699eaec0417a5ef511b4e71c73b`
- accepted task 3.2 implementation：`11cae33251f996d6410f7953ce50af1c43ffd7fe`
- accepted task 3.2 checkpoint：`3ffd36a91402f58a7492905a706868c2874ba93d`
- OpenSpec：12/29，next `3.3`
- G3 是唯一 apply owner；G2 已归档；3.2 已由 Controller 独立验收；3.3 已解锁但尚未开始
- 当前 task capsule：`.codex/routego-program/tasks/integration-3.3.json`
- 完成任务 evidence：`.codex/routego-program/evidence/integration-generation-2-tasks.json` 与 `.codex/routego-program/evidence/integration-generation-3-tasks.json`
- 旧完整交接原文：commit `428c1a904299f7043feb3fd08d5c0265f3098243` 中本路径，SHA-256 `ca13ad7277ab712e3b1f0d889b9b3f0e50d2aa6b1dd66e52875336acc452bfbb`

G3 的接管验收在 `observableCompactions=0` 下完成；任务 3.2 期间出现第 1 次可观测压缩，健康审计已恢复准确状态。启动字节统一按 CRLF 规范化为 LF 后计算；验证器失败发送 `HANDOFF_AUDIT_FAILED`。

直接 `send_message_to_thread` 后 `read_thread` 回读是主链；30 分钟自动化只做漏报兜底。G3 只能先执行 3.3，并在任务/任务组/checkpoint/阻塞/偏差/交付后立即直报 Controller 与回读确认。
