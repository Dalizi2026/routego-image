# Routego Image 开发代理规则

## 开始工作前

## 工作区合并与新增目录禁令

用户已在 2026-07-23 明确要求完成工作区合并。唯一允许的执行工作区是
`/Users/dalizi/Documents/Routego Image 1.0/controller-g12`；共同 Git 历史只保存在同级
`repository`，不得把它当作第二个执行工作区。

- 后续窗口可以创建新的可见对话，但必须复用上述现有执行工作区和现有分支；不得创建新的项目目录、worktree、clone、临时执行目录或 successor 文件夹。
- 禁止运行 `git worktree add`、`git clone`、`mkdir` 创建工作目录，或以“交接/隔离/顺序任务”为理由新建目录。需要一个新目录、独立 worktree 或永久测试目录时，必须先取得用户新的明确授权。
- 每次任务范围切换仍须核对任务胶囊、唯一 owner、工作区 clean、完整性、预算和零压缩 acceptance；若同一工作区存在并发写入或无法满足这些门禁，停止并向 Controller 报告，而不是新建目录绕过门禁。
- 此禁令不授权产品实现、依赖安装、真实数据操作、外部访问或删除；原有 OpenSpec、安全和批准门禁继续生效。

PD-008 默认使用低上下文、无损细节启动。每个顶层任务或 successor 依次读取：

1. 本文件；
2. `.codex/routego-program/authority-summary.md`；
3. 紧凑 `.codex/routego-program/program.json`；
4. 自己的 `.codex/routego-program/threads/<lane>.json`；
5. 自己的 `.codex/routego-program/handoffs/*.capsule.json`；
6. capsule 指定的当前 task capsule 或 `tasks.md` 精确任务段；
7. capsule 指定的直接相关 delta/main specs；
8. capsule 指定的当前有效 PD。

默认启动最多 12 个文件、120 KiB UTF-8。字节数统一先把 CRLF 规范化为 LF 再计算，避免不同 Git 工作树的换行策略产生虚假差异。不得在启动时完整读取全部 18 份 main specs、全部 archived changes、其他 lane 的完整工件、无关 evidence、predecessor 线程历史或旧状态 notes。

只有 capsule/Git/OpenSpec/状态不一致、公共 Schema/架构/所有权/依赖边界、当前任务直接修改能力、验收失败追查根因、`PLAN_DEVIATION` 或健康审计无法确认权威时，才定向读取受影响资料。全量审计只允许用于项目初建、最终 Integration conformance、main spec 同步/archive、release/rollback 门禁、定向恢复失败或用户明确要求。

子代理不读取整个项目历史；提示只包含当前 OpenSpec 任务 ID、允许/禁止文件、验证命令、必要规格片段和 evidence 引用。

若任一权威文件缺失或互相矛盾，停止实现并通知 Program Controller。

handoff capsule 必须通过 `.codex/routego-program/scripts/validate-handoff-capsule.mjs`。失败时发送 `[HANDOFF_AUDIT_FAILED]`，不得猜测继续。successor 在 handoff acceptance 前出现一次上下文压缩时发送 `[HANDOFF_CONTEXT_BUDGET_FAILED]`；successor 不得激活，predecessor 保持 owner，下一产品任务继续锁定。

线程状态中的 `threadId: pending` 表示 Program Controller 已在创建该顶层任务，属于合法启动状态；任务应核对 lane、角色、起始 commit 和 worktree 后继续只读审计，等待真实 ID 回填，不得把 `pending` 单独视为阻塞。

## 顶层任务与子代理

- Program Controller 只为 Foundation、Creation、Library、Studio、Integration 这类 OpenSpec change 负责人创建用户可见的顶层 Codex 新任务。
- 顶层任务通常拥有独立 worktree；但在“工作区合并与新增目录禁令”有效期间，所有顶层任务必须复用唯一现有执行工作区，不得新建 worktree、分支目录或 successor 目录。
- 同一 Lane 的唯一可见执行线程可在第 1、2 次可观察上下文压缩期间连续处理顺序 OpenSpec 任务；不得仅因任务顺序推进自动创建 successor 工作区或线程。
- 每次范围切换仍须由 Controller 明确激活，并重新核对 task capsule、授权范围、唯一 owner、工作区 clean、完整性和启动预算；在该 in-thread scope acceptance 完成前，新任务保持锁定且不得写入。
- 旧插件审计、上游审计、模块拆分、测试、审查等有界工作，默认由对应顶层任务在自己的线程内派发子代理。
- 子代理不得再创建新的用户顶层任务，除非上下文交接协议明确要求创建继任任务。
- 常规步骤、读取进度和非阻塞发现不回传 Program Controller；只回传真实阻塞、契约变更请求和最终交付。
- Program Controller 通过任务状态文件和 `read_thread` 主动检查进度，避免把所有工作日志灌入控制线程上下文。
- 线程输出 final answer 后即进入 idle，不具备持续轮询能力。禁止写“你无需操作，其他任务完成后我会自动继续”，除非已经配置明确的 follow-up 发送方或 heartbeat。
- 强制线程清理：由自动化或 Controller 创建的任务线程在其交付被 Controller 验收、Git 已干净且不存在后续激活范围后，必须立即调用 `set_thread_archived` 归档。不得保留已完成、失败、取消或空闲的自动任务线程；不得归档当前 Controller、正在执行的唯一 apply owner，或仍在等待验收的交付线程。平台不支持物理删除时，归档视为唯一允许的清理动作。
- 有依赖关系的任务必须在完成时调用 `send_message_to_thread`，向依赖线程发送结构化完成消息并触发新一轮。
- 结构化完成消息至少包含任务类型、分支、完整 commit SHA、交付文件、验证结果和阻塞项。
- 关键链路使用 heartbeat 兜底时，直接完成消息仍是主路径；依赖满足后立即删除或暂停 heartbeat。

## OpenSpec 所有权

- 每个 change 只有任务主代理可以运行 apply 或修改该 change 的 OpenSpec 工件及 `tasks.md`。
- 子代理只修改明确分配的实现或测试文件，不得勾选任务。
- 任务只有在代码已提交、测试通过并合入对应集成基线后才能标记完成。
- 需求或共享契约变化必须先更新 OpenSpec，再继续实现。

## 规划一致性门禁

- 开始每个任务前，主代理必须重新读取 `openspec instructions apply --change <change> --json`，确认准确的任务 ID、依赖、文件所有权和验证命令。
- 实现只能覆盖当前任务声明的能力和文件范围；不得顺手重构、增加产品功能、替换技术栈或修改尚未解锁的后续任务。
- 子代理提示必须引用明确的 OpenSpec 任务 ID、允许文件和禁止文件；没有任务 ID 的实现工作不得派发。
- 遇到需要修改公共 Schema、架构、依赖边界、任务顺序、范围或验收标准的情况，立即停止相关实现并向 Program Controller 发送 `[PLAN_DEVIATION]`，说明原因、影响和建议的 OpenSpec 修订。
- 未经 OpenSpec update 和 Program Controller 确认，不得以“实现更方便”为由偏离已确认设计。
- 完成任务时必须按顺序执行：运行任务列出的验证、检查 Git 差异范围、提交实现、记录 commit SHA，最后由唯一 apply-owner 勾选 `tasks.md`。
- 测试失败、工作区不干净、出现范围外文件或提交尚未形成时，不得勾选任务完成。
- 每完成一个任务组，主代理必须进行规划一致性审计：对照 proposal、design、全部相关 specs、tasks 和审计风险清单，确认没有遗漏、提前实现或隐式范围扩张。

## 并行文件所有权

- Foundation/Integration 独占共享 Schema、根依赖、锁文件、workspace 配置、插件 manifest 和发布流程。
- Creation 独占生成/编辑适配、任务执行、transport 和 MCP/HTTP 运行时实现。
- Library 独占配置、图库、收藏夹、文件并发、回收站和 ZIP。
- Studio 独占前端页面、组件、遮罩编辑器和浏览器测试。
- 未经 Program Controller 明确授权，不得跨泳道修改文件。

## 上下文健康协议

- 当前对话出现上下文压缩、checkpoint 或历史摘要时，先读取线程状态并记录新的事件指纹。
- 第 1～2 次可观测压缩：完成健康审计；只有权威状态、change、HEAD、下一任务、契约、所有权和测试状态均可确认时才继续。
- 第 3 次可观测压缩：必须立即执行低上下文无损交接（PD-014），由 Controller 创建新的可见线程和独立 worktree；原线程不得继续大型任务，也不得等到第 4 或第 5 次。
- 同一线程在第三次压缩后不得继续承担新的任务范围；新的继任线程从零重新计数，并在接管验收后成为唯一 apply owner。
- 健康审计失败、无法准确确认权威状态或出现高风险外部条件时，无论压缩次数是否达到五次，都必须提前交接。
- 交接前不得开始新的大型任务；在安全边界提交工作，并在 `.codex/routego-program/handoffs/` 写清单。
- 继任任务必须从提交后的 branch/commit 创建，不使用携带完整旧历史的 fork。
- 继任任务确认 commit、OpenSpec 状态和下一任务后，旧任务才允许归档。
- 第 3 次可观测压缩或提前健康交接所创建的每一个继任任务，必须完整继承“直接回传主链 + 定时自动化兜底链”约束。Controller 必须在 task 创建提示、registration、handoff acceptance 和 sole-owner activation 中重复写明该约束。
- 同一四个治理节点还必须重复确认：PD-008 分层读取、无损 history/evidence 引用、12 文件/120 KiB 启动预算和 acceptance 前零压缩门禁。
- 继任任务的接管确认只有在其明确承诺：每个 OpenSpec 任务、任务组、安全检查点、阻塞、偏差、交接和交付完成后立即调用真实 `send_message_to_thread` 回传 Controller，并调用 `read_thread` 确认送达后才有效；仅输出 final 标签或等待自动化不算完成。
- 若继任任务未确认上述回传契约，旧任务不得归档，继任任务不得成为唯一 apply-owner，也不得开始下一项产品任务。

## 安全与 Git

- 不提交 API Key、认证头、真实用户图片、本地配置、图库、构建产物或测试报告缓存。
- 不使用 `git reset --hard`、破坏性 checkout 或覆盖用户未提交修改。
- 合并失败使用修复提交或 `git revert`，不重写已共享历史。
- 所有交付必须包含 OpenSpec 任务 ID、commit SHA、测试结果、阻塞项和残余风险。
