# Routego Image 1.0 紧凑权威摘要

本文件只保存稳定规则。历史过程、失败修正和任务证据位于 history/ 与 evidence/，必须按完整 commit SHA、路径和 SHA-256 定向读取；不得用对话记忆、final 标签、线程摘要或自动化 memory 代替。

## 产品与公共契约

- 目标是可正式使用的 Routego Image 1.0，不得擅自降级为 MVP、原型或临时实现。
- 当前已安装版本仍有 routego_edit；未合并的 streamline-routego-image-generation 目标契约将其替换为只读 routego_prepare_regeneration，总数仍为七个。只有新 change 独立验收、合并、同步和归档后，目标契约才成为已部署事实。
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

- PD-014：任意角色在第 3 次可观测压缩后必须立即低上下文交接，不得继续大型任务。


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

- 唯一主链：当前 apply owner 每完成任务、任务组、安全 checkpoint、阻塞、偏差、handoff、activation 或 delivery，立即 `send_message_to_thread` 到当前 Controller；Controller 收到后必须 `read_thread` 确认，并在同一回合完成验收、激活、交接或归档。final 标签不算送达。
- heartbeat、轮询或自动化只能检查遗漏回传，绝不得唤醒、激活、推进、验收或代替线程间回传；漏报时必须保持任务锁定并作为治理失败处理。
- task 创建、registration、acceptance、Controller/sole-owner activation 必须重复确认低上下文、无损 evidence、预算和直接回传链。Controller 只调度和独立验收，不代替 streamline apply-owner 写产品实现或勾选其任务。

## 外部授权和安全

- 不提交或暴露真实 API key、认证值、用户图片、本地配置、真实 Library/relay 数据、图片 data URL 或敏感日志。
- 用户已于 2026-07-25 明确批准本 change 的 U-2-Netp 与 ONNX Runtime Web/WASM 联网下载、完整性检查和新依赖安装；U-2-Netp 与 ONNX Runtime Web 1.20.1 已通过官方 SRI、SHA-1、SHA-256、归档、版本和许可证检查，可进入 Task 6.2 离线打包，但不得替换当前安装。
- 未经用户当前明确批准，不执行 billable probe/request、marketplace、部署、发布、迁移、删除或 release。
- Integration 7.2、8.2、9.1 需要新的用户明确批准。
- 不使用 git reset --hard 或破坏性 checkout；保留用户未提交修改；共享历史用修复提交或 revert。
