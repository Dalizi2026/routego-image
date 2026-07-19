# Controller generation 7 低上下文交接入口

权威机器胶囊：`.codex/routego-program/handoffs/controller-generation-7.capsule.json`

- source：Controller G6 task `019f764e-e4a7-7270-b06a-a846f2b0d932`
- source worktree：`C:\Users\MLTZ\.codex\worktrees\a70f\生图插件`
- source branch：`codex/routego-controller-g6`
- source clean baseline：`5230567298c8af902a87e70e32ed24a6dc9f9d3e`
- successor：Controller G7 task `019f77b8-1e24-74c0-8102-66dd2cdd5f20`
- successor worktree：`C:\Users\MLTZ\.codex\worktrees\340f\生图插件`
- planned branch：`codex/routego-controller-g7`
- G6 observable compactions：5；G6 只保留冻结交接支持，G7 在 acceptance 和显式 activation 前不得自激活
- Integration G6：`fcacc1ab571fdf06869415cbf0c34494b30c289f`，唯一 apply owner；OpenSpec 17/29；task 4.3 WIP 已保存，PD-012 三文件规划更新进行中，产品代码锁定

G7 必须在零压缩条件下纳入 registration，按 capsule 顺序完整读取 mandatoryFiles，按 CRLF→LF 后的 UTF-8 字节计数，并通过专用 Controller handoff validator。acceptance 仅为审计；只有 G6 纳入显式 activation、再次验证并真实回报/read-back 后，G7 才成为权威 Controller。

直接 `send_message_to_thread` 后 `read_thread` 回读是主链；`routego-program-continuity` 的 `ARCHIVE_EARLY_V5` 每 30 分钟只做去重后的漏报兜底。G7 创建、registration、acceptance 和 Controller activation 均必须重复确认 PD-008 预算、无损 history/evidence 引用和双路径契约。
