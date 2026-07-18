# Routego Image 1.0 紧凑权威摘要

本文件只保存稳定规则。历史过程、失败修正和任务证据位于 history/ 与 evidence/，必须按完整 commit SHA、路径和 SHA-256 定向读取；不得用对话记忆、final 标签、线程摘要或自动化 memory 代替。

## 产品与公共契约

- 目标是可正式使用的 Routego Image 1.0，不得擅自降级为 MVP、原型或临时实现。
- 七个公共 MCP 工具固定为：routego_status、routego_generate、routego_edit、routego_batch、routego_search_library、routego_manage_library、routego_open_studio。
- 公共 ImageArtifact.phase 固定为 partial | final。Library 内部 source rendition 不扩大公共 phase。
- 公共契约指纹：1393f2d00a052e881afca0309021d20b1a17d7fc2e9c505410d4f712f4ec113c。
- 需求或公共契约变化必须先 PLAN_DEVIATION、OpenSpec update 和 Controller 确认；实现便利不是偏离理由。

## OpenSpec 与完成顺序

- 每个 change 只有一个顶层 apply owner；Controller、审查者和子代理不得勾选其 tasks.md。
- 开始任务前读取 fresh apply instructions，核对任务 ID、依赖、allowed/forbidden 文件和验证。
- 完成顺序固定为：运行任务验证 → 检查差异范围 → 提交实现 → 记录完整实现 SHA → 唯一 apply owner 更新 tasks.md → 提交 task-state → 提交 lane checkpoint → 直接回报并回读。
- 测试失败、Git dirty、范围外文件或缺少提交时不得勾选完成。

## Lane 所有权

- Foundation/Integration：共享 Schema、根依赖/锁文件/workspace、插件 manifest、集成与发布流程。
- Creation：生成/编辑 provider 适配、执行、transport、MCP/HTTP 运行时实现。
- Library：配置、图库、收藏夹、并发文件安全、回收站和 ZIP。
- Studio：页面、组件、遮罩编辑器和浏览器测试。
- 子代理只能修改提示中明确的当前任务文件；无任务 ID 不得写产品代码。

## 低上下文无损交接

- PD-008 取代 successor 启动时默认全量重读。默认只读 AGENTS、本文、紧凑 program、自 lane state、handoff capsule、task capsule、直接相关 delta/main specs 和当前有效 PD。
- 默认最多 12 个文件、120 KiB UTF-8；启动字节统一按 CRLF 规范化为 LF 后计算，必须与 capsule 的精确预期值一致；authority summary 16 KiB、handoff capsule 24 KiB、program 48 KiB、lane state 32 KiB、直接治理消息 12 KiB。
- 只有 capsule/状态/OpenSpec/Git 不一致、公共边界、验收根因、PLAN_DEVIATION 或健康审计失败时定向展开。
- 全量审计仅限初建、最终 Integration conformance、main spec 同步/archive、release/rollback 门禁、定向恢复失败或用户明确要求。
- acceptance 前出现一次压缩即 HANDOFF_CONTEXT_BUDGET_FAILED；successor 不得激活，predecessor 保持 owner。
- capsule validator 失败即 HANDOFF_AUDIT_FAILED；不得依靠猜测继续。

## PD-006 上下文门禁

- 第 1～2 次可观测压缩：记录指纹并完成低上下文健康审计。
- 第 3 次：建立 Git 安全 checkpoint，完成当前小型/原子边界，不启动新大型任务。
- 第 4 次：预交接，只完成当前原子任务和交接准备。
- 第 5 次：未完成工作必须交给全新 task 和新 worktree。
- 权威状态无法确认时可提前交接。

## 双路径回报

- 主链：当前 apply owner 每完成任务、任务组、安全 checkpoint、阻塞、偏差、handoff、activation 或 delivery，立即 send_message_to_thread 到 program.json 当前 Controller，并 read_thread 确认。
- 兜底：routego-program-continuity 每 30 分钟只检查紧凑状态中的漏报，以 latestDirectCheckpoint 去重并归档自己的运行任务。
- task 创建、registration、acceptance、Controller/sole-owner activation 必须重复确认低上下文、无损 evidence、预算和双路径回报。final 标签不算送达，heartbeat 不自动继承。

## 外部授权和安全

- 不提交或暴露真实 API key、认证值、用户图片、本地配置、真实 Library/relay 数据、图片 data URL 或敏感日志。
- 未经用户当前明确批准，不执行 billable probe/request、安装替换、marketplace、部署、发布、迁移、删除或 release。
- Integration 7.2、8.2、9.1 需要新的用户明确批准。
- 不使用 git reset --hard 或破坏性 checkout；保留用户未提交修改；共享历史用修复提交或 revert。
