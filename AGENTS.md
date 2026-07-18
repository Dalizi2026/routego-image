# Routego Image 开发代理规则

## 开始工作前

每个 Codex 任务或子代理必须依次读取：

1. `routego-image-1.0-plan.md`
2. 本文件
3. `.codex/routego-program/program.json`
4. 自己的 `.codex/routego-program/threads/<lane>.json`
5. 对应 `openspec/changes/<change>/` 下的 proposal、design、specs 和 tasks

若任一权威文件缺失或互相矛盾，停止实现并通知 Program Controller。

线程状态中的 `threadId: pending` 表示 Program Controller 已在创建该顶层任务，属于合法启动状态；任务应核对 lane、角色、起始 commit 和 worktree 后继续只读审计，等待真实 ID 回填，不得把 `pending` 单独视为阻塞。

## 顶层任务与子代理

- Program Controller 只为 Foundation、Creation、Library、Studio、Integration 这类 OpenSpec change 负责人创建用户可见的顶层 Codex 新任务。
- 顶层任务必须拥有独立 worktree、分支、线程状态文件、清晰标题，并在任务列表中置顶。
- 旧插件审计、上游审计、模块拆分、测试、审查等有界工作，默认由对应顶层任务在自己的线程内派发子代理。
- 子代理不得再创建新的用户顶层任务，除非上下文交接协议明确要求创建继任任务。
- 常规步骤、读取进度和非阻塞发现不回传 Program Controller；只回传真实阻塞、契约变更请求和最终交付。
- Program Controller 通过任务状态文件和 `read_thread` 主动检查进度，避免把所有工作日志灌入控制线程上下文。
- 线程输出 final answer 后即进入 idle，不具备持续轮询能力。禁止写“你无需操作，其他任务完成后我会自动继续”，除非已经配置明确的 follow-up 发送方或 heartbeat。
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
- 第 2 次可观测压缩必须建立 Git 检查点；第 3 次必须交给全新 Codex 任务和新 worktree。
- 即使不足三次，重新读取权威文件后仍不能准确确认 change、HEAD、下一任务、契约、所有权或测试状态，也必须提前交接。
- 交接前不得开始新的大型任务；在安全边界提交工作，并在 `.codex/routego-program/handoffs/` 写清单。
- 继任任务必须从提交后的 branch/commit 创建，不使用携带完整旧历史的 fork。
- 继任任务确认 commit、OpenSpec 状态和下一任务后，旧任务才允许归档。
- 第 3 次可观测压缩或提前健康交接所创建的每一个继任任务，必须完整继承“直接回传主链 + 定时自动化兜底链”约束。Controller 必须在 task 创建提示、registration、handoff acceptance 和 sole-owner activation 中重复写明该约束。
- 继任任务的接管确认只有在其明确承诺：每个 OpenSpec 任务、任务组、安全检查点、阻塞、偏差、交接和交付完成后立即调用真实 `send_message_to_thread` 回传 Controller，并调用 `read_thread` 确认送达后才有效；仅输出 final 标签或等待自动化不算完成。
- 若继任任务未确认上述回传契约，旧任务不得归档，继任任务不得成为唯一 apply-owner，也不得开始下一项产品任务。

## 安全与 Git

- 不提交 API Key、认证头、真实用户图片、本地配置、图库、构建产物或测试报告缓存。
- 不使用 `git reset --hard`、破坏性 checkout 或覆盖用户未提交修改。
- 合并失败使用修复提交或 `git revert`，不重写已共享历史。
- 所有交付必须包含 OpenSpec 任务 ID、commit SHA、测试结果、阻塞项和残余风险。
