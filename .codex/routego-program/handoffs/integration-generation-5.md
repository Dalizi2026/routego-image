# Integration generation 5 低上下文交接入口

权威机器胶囊：`.codex/routego-program/handoffs/integration-generation-5.capsule.json`

- Controller：G6 task `019f764e-e4a7-7270-b06a-a846f2b0d932`
- source：Integration G4 task `019f7633-a831-7b62-a00a-d4b6fba5515e`
- source worktree：`C:\Users\MLTZ\.codex\worktrees\a818\生图插件`
- source branch：`codex/routego-integration-g4`
- clean handoff baseline：`cc49c06406a8526f1bdd43e4ab158421b367ee6c`
- successor：Integration G5 task `019f76b1-7601-7960-80ce-d6b056c896bd`
- successor worktree：`C:\Users\MLTZ\.codex\worktrees\f651\生图插件`
- planned branch：`codex/routego-integration-g5`
- source observable compactions：3；在新的大型 task 4.2 前提前交接
- OpenSpec：16/29；task 4.1 已接受并同步；task 4.2 在 G5 激活前锁定

G5 registration 前只核对身份、worktree、HEAD 和 Git clean。纳入 registration governance 后，严格按 capsule 顺序读取 12 个 mandatoryFiles、按 CRLF→LF 后 UTF-8 字节计数并运行通用 handoff validator。acceptance 只表示审计通过；G4 在显式归档与 G5 sole-owner activation 前仍是唯一 apply owner。

直接 `send_message_to_thread` 后 `read_thread` 回读是主链；30 分钟自动化只做去重后的漏报兜底并首先归档自身 run。七个公共工具、公开 `partial | final`、外部审批与安全边界不变。
