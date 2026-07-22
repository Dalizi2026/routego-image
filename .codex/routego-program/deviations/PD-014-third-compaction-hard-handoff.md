# PD-014 第三次可观测压缩强制低上下文交接

状态：生效
适用范围：所有角色（Controller、apply-owner、审查者、子代理、自动化）
生效原因：用户明确要求，在约 50 万上下文模型下，可观测压缩达到第 3 次后必须直接工作交接，并使用低上下文无损交接；否则容易失败。

## 硬性规则

1. 每个任务必须维护 `observableCompactions` 和 `lastCompactionFingerprint`。
2. 当 `observableCompactions >= 3` 时：
   - 不得开始新的大型任务；
   - 必须在当前安全边界停止产品推进；
   - 必须立即启动低上下文无损交接（PD-008）；
   - 必须创建新任务 + 新 worktree + 新 generation 的继任者，不得 fork 完整旧历史。
3. 第 1 次、第 2 次可观测压缩仍按既有健康审计继续；不得等到第 5 次。
4. 交接启动包必须通过预算校验，默认最多 12 个文件、120 KiB 规范化 UTF-8；单文件超过 20 KiB 不得整份读取。
5. 交接失败码：
   - `HANDOFF_CONTEXT_BUDGET_FAILED`
   - `HANDOFF_AUDIT_FAILED`
6. 自动化、心跳和 Controller 都不得绕过本规则。

## 与既有规则关系

- 本规则收紧 AGENTS.md / PD-006 中“第 3 次压缩后建立检查点并限制新大型任务”的要求，升级为“第 3 次后强制交接”。
- PD-008 的分层读取、无损 evidence 引用、启动预算和零压缩接受门禁继续有效。
- 直接 `send_message_to_thread` + `read_thread` 仍是主链；自动化只做漏报兜底。

## 安全边界

- 不因本规则修改产品代码。
- 不读取真实凭证、图片、配置。
- 不联网、不安装、不部署、不发布。
