# Integration generation 6 low-context handoff

Authoritative capsule: `.codex/routego-program/handoffs/integration-generation-6.capsule.json`

- Controller: G6 task `019f764e-e4a7-7270-b06a-a846f2b0d932`
- source: Integration G5 task `019f76b1-7601-7960-80ce-d6b056c896bd`
- source worktree: `C:\Users\MLTZ\.codex\worktrees\f651\生图插件`
- source branch: `codex/routego-integration-g5`
- clean handoff baseline: `5cbf49bd01d6016e3ed9daf54e8d03169a8f62bf`
- successor: Integration G6 task `019f7774-d842-7a20-b9a9-88322de1dc1c`
- successor worktree: `C:\Users\MLTZ\.codex\worktrees\d0dd\生图插件`
- planned branch: `codex/routego-integration-g6`
- source observable compactions: 4; successor acceptance requires zero compactions
- OpenSpec: 17/29; task 4.2 accepted; task 4.3 locked until explicit G6 sole-owner activation

Before acceptance, G6 performs only the declared 12-file layered audit, normalized UTF-8 budget check and capsule validator. Acceptance is audit-only. G5 remains frozen and sole apply-owner until Controller activation. Direct `send_message_to_thread` plus `read_thread` is the primary reporting path. The 30-minute V4 automation is missed-message fallback and archives each own run by exact thread ID.
