# Routego Image 开发代理规则

## 开始工作前

每个 Codex 任务或子代理必须依次读取：

1. `routego-image-1.0-plan.md`
2. 本文件
3. `.codex/routego-program/program.json`
4. 自己的 `.codex/routego-program/threads/<lane>.json`
5. 对应 `openspec/changes/<change>/` 下的 proposal、design、specs 和 tasks

若任一权威文件缺失或互相矛盾，停止实现并通知 Program Controller。

## OpenSpec 所有权

- 每个 change 只有任务主代理可以运行 apply 或修改该 change 的 OpenSpec 工件及 `tasks.md`。
- 子代理只修改明确分配的实现或测试文件，不得勾选任务。
- 任务只有在代码已提交、测试通过并合入对应集成基线后才能标记完成。
- 需求或共享契约变化必须先更新 OpenSpec，再继续实现。

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

## 安全与 Git

- 不提交 API Key、认证头、真实用户图片、本地配置、图库、构建产物或测试报告缓存。
- 不使用 `git reset --hard`、破坏性 checkout 或覆盖用户未提交修改。
- 合并失败使用修复提交或 `git revert`，不重写已共享历史。
- 所有交付必须包含 OpenSpec 任务 ID、commit SHA、测试结果、阻塞项和残余风险。
