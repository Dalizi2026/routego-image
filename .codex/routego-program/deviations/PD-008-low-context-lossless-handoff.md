# PD-008：低上下文、可验证、无损细节交接

- Status: 用户明确批准，立即适用于所有当前与未来角色
- Scope: Controller、Foundation、Creation、Library、Studio、Integration、successor、顶层任务、子代理和连续性自动化
- Decision date: 2026-07-18
- Supersedes: successor 启动时默认完整读取全部主规格、全部归档 change 和全部历史状态的做法

## 决策

低上下文不等于删减细节。完整事实必须保存在 Git 管理的权威 history/evidence 文件中，并使用完整 commit SHA、文件路径和 SHA-256 内容指纹引用。对话记忆、线程摘要、final 标签和自动化 memory 均不是权威证据。

历史交接事实、产品需求、OpenSpec 任务、七个公共 MCP 工具和公共 ImageArtifact.phase=partial|final 不因本决策改变。旧文件在其原始提交中的完整内容继续有效，并由 history 索引定位；当前状态文件不再无限追加历史叙述。

## 分层权威资料

1. authority-summary.md：只保存稳定产品/治理边界，不保存历史日志。
2. program.json：只保存当前 Controller、唯一 apply owner、successor、change/进度/下一任务、锁定状态、最近直接 checkpoint、当前 blocker/偏差/外部门禁、自动化和必要提交链。
3. threads/<lane>.json：只保存 lane 当前有效状态、最近 checkpoint、当前任务/所有权和 successor。
4. history/：用源提交、Git blob、SHA-256 和字节数保存被收敛状态的无损索引。
5. evidence/：每个完成任务或修正链记录 task ID、实现/task-state/checkpoint SHA、精确文件、验证结果、根因/失败方案和关联决策。
6. handoffs/*.capsule.json：机器可验证的 successor 胶囊；简短 Markdown 只做人类入口。
7. tasks/*.json：当前 OpenSpec 任务的精确任务、文件、规格和验证胶囊。

## successor 最小启动层

默认强制读取不超过 12 个文件、UTF-8 总量不超过 120 KiB：

1. AGENTS.md 的低上下文规则；
2. authority-summary.md；
3. 紧凑 program.json；
4. 自己 lane 当前状态；
5. 当前 handoff capsule；
6. 当前 task capsule 或 tasks.md 精确任务段；
7. 当前任务直接修改的 delta spec 和必要 main spec；
8. 当前有效 PD 决策。

默认禁止启动时完整读取全部 18 份 main specs、全部 archived changes、其他 lane 的完整 proposal/design/tasks、无关历史 evidence、predecessor 完整线程历史或旧状态 notes。

## 定向展开和全量审计

仅在下列情况定向读取受影响资料：

- capsule、Git、OpenSpec 或当前状态不一致；
- 当前任务涉及公共 Schema、架构、文件所有权或依赖边界；
- 当前任务直接修改某能力；
- 验收失败需要追查上游根因；
- 出现 PLAN_DEVIATION；
- 健康审计无法确认权威状态。

全量审计只允许用于：项目初建、最终 Integration conformance、main spec 同步和 change archive、release/rollback 最终门禁、定向恢复失败，或用户明确要求。

## 上下文预算

- authority-summary.md：建议不超过 16 KiB；
- 单个 handoff capsule：建议不超过 24 KiB；
- 单个 registration/acceptance/activation 直接消息：建议不超过 12 KiB；
- program.json：建议不超过 48 KiB；
- 单个 lane 当前状态：建议不超过 32 KiB；
- successor 默认启动：不超过 120 KiB UTF-8、最多 12 个文件。

不得删除证据或省略关键字段来满足预算。超出内容必须转移到带完整 SHA 和内容指纹的 history/evidence 文件。

若 successor 在 handoff acceptance 前发生一次可观测上下文压缩，必须发送 HANDOFF_CONTEXT_BUDGET_FAILED：

- successor 不得激活；
- predecessor 保持唯一 owner；
- 下一产品任务继续锁定；
- 必须缩小当前状态和 capsule；
- 必要时创建新的干净 successor；
- 启动审计导致的压缩不得视为成功接管。

## 机器门禁

.codex/routego-program/scripts/validate-handoff-capsule.mjs 必须检查：

- capsule 和 task capsule 必填字段；
- 完整 SHA 可达及 handoff parent/starting 关系；
- 当前 task ID 与源 OpenSpec 一致；
- allowed/forbidden 范围无冲突，允许新文件的父目录存在；
- evidence、task、spec、authority summary 内容指纹；
- program、lane、capsule 的 task/generation/thread/worktree/branch 一致；
- 七工具和公共 phase 指纹；
- 文件与启动预算；
- 敏感 payload、图片 data URL 和长 Base64；
- 双路径回报契约；
- 最终 Git clean。

失败必须发送 HANDOFF_AUDIT_FAILED，不得猜测继续。

## 全角色与自动化生效

- 所有未来 task creation、registration、acceptance、Controller activation 和 sole-owner activation 必须重复确认分层读取、无损 evidence、预算和双路径回报。
- 子代理提示只包含当前任务 ID、允许/禁止文件、验证命令、必要规格片段和 evidence 引用。
- routego-program-continuity 每 30 分钟只读取紧凑 current state、latestDirectCheckpoint 和必要 lane checkpoint；不得周期性读取全部规格或归档 change。
- 直接 send_message_to_thread 后 read_thread 回读是主链；自动化仅是漏报兜底并归档自己的运行任务。

## 不变安全边界

- Controller 不代写 Integration 产品代码或 OpenSpec 产品要求。
- 不改变七个公共 MCP 工具、公共 phase、任务顺序或文件所有权。
- 不使用真实凭证、认证值、用户图片、真实 Library/relay 或付费请求。
- 不执行安装替换、marketplace、部署、发布、迁移、删除或 release。
- Integration 7.2、8.2、9.1 仍需新的用户明确批准。
