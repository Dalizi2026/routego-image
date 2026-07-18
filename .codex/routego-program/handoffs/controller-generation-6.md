# Controller generation 6 低上下文交接入口

权威机器胶囊：`.codex/routego-program/handoffs/controller-generation-6.capsule.json`

- source：Controller G5 task `019f751c-75c3-7e52-9af1-28db9dad4463`
- source worktree：`C:\Users\MLTZ\.codex\worktrees\5106\生图插件`
- source branch：`codex/routego-controller-g5`
- source clean baseline：`d871bbfc5827e7abe6404a42d4b0bceff63d550c`
- successor：Controller G6 task `019f764e-e4a7-7270-b06a-a846f2b0d932`
- successor worktree：`C:\Users\MLTZ\.codex\worktrees\a70f\生图插件`
- planned branch：`codex/routego-controller-g6`
- G5 observable compactions：4，进入预交接状态但在显式激活前仍为权威 Controller
- Integration G4：`a452f2c66689555db0c5d8a5bb47e86ca3cd82cb`，唯一 apply owner，任务 3.5 active，OpenSpec 14/29

G6 registration 后必须按 capsule 顺序读取 11 个 mandatoryFiles，按 CRLF→LF 后的 UTF-8 字节计数，运行专用 Controller handoff validator，并真实发送 acceptance 后回读确认。acceptance 前任何可观测压缩都必须触发 `HANDOFF_CONTEXT_BUDGET_FAILED`，G6 不得激活。

直接 `send_message_to_thread` 后 `read_thread` 回读是主链；30 分钟自动化只做去重后的漏报兜底。G6 创建、registration、acceptance 和 Controller activation 均必须重复确认 PD-008 预算、无损 history/evidence 引用和双路径契约。
