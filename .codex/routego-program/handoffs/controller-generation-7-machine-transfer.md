# Routego Image 1.0 跨电脑停止与工作交接

- 交接时间：2026-07-19 09:55:25 +08:00
- 交接原因：用户明确要求停止所有工作，并切换到另一台电脑继续开发
- 项目：Routego Image 1.0
- 当前 OpenSpec change：`integrate-routego-image-plugin`
- 当前进度：17/29
- 当前任务：4.3，未勾选、未完成、产品锁定
- 交接语义：停止并冻结；不是完成、发布、部署或 task 4.3 验收

## 1. 必须先理解的结论

1. 当前软件开发没有完成。OpenSpec 仅完成 17/29，剩余任务从 4.3 开始。
2. Controller G7 的交接前 clean 治理基线是 `6e7ad6c17258949397b2050b5aa002daff799c73`；本文件所在的后续单文件提交是最终冻结交接 HEAD，不包含产品或 OpenSpec 修改。
3. Integration G6 已停止在 clean 非完成 WIP 安全检查点 `34fd18aca083199028b8f9a54f8fc26f023711db`。
4. `34fd18a...` 只保存跨电脑迁移现场，不代表安全修复通过，也不代表 Controller 已接受。
5. task 4.3 四个 Integration 文件仍锁定，不得恢复；必须先独立复审并接受 PD-012 的 Creation 两文件修复。
6. 七个公共 MCP 工具和公共 `ImageArtifact.phase=partial|final` 始终冻结。
7. `externalStateAuthorized=false`。不得使用真实凭证、Authorization、用户图片、真实 Library/relay、网络或付费请求/探测，也不得安装、marketplace、部署、发布、迁移、删除或 release。
8. 7.2、8.2、9.1 仍需用户在执行当时重新明确批准。

## 2. 当前权威身份与冻结状态

### Program Controller

- generation：7
- task/thread ID：`019f77b8-1e24-74c0-8102-66dd2cdd5f20`
- branch：`codex/routego-controller-g7`
- worktree：`C:\Users\MLTZ\.codex\worktrees\340f\生图插件`
- 交接前 clean 治理基线 / 本文件提交的父提交：`6e7ad6c17258949397b2050b5aa002daff799c73`
- 最终冻结 HEAD：本交接文件所在提交；在新电脑运行 `git rev-parse HEAD` 获取其完整 SHA，并确认其父提交精确为上一行 SHA
- authority：G7 是停止前最后一个权威 Controller
- observableCompactions：1
- compaction fingerprint：`controller|routego-image-1.0|6e7ad6c17258949397b2050b5aa002daff799c73|context-compaction-1-during-machine-transfer-handoff-before-byte-budget-and-commit|17/29`
- 压缩后健康审计：通过；branch、HEAD、OpenSpec 17/29、task 4.3 锁定状态、Integration WIP 检查点和精确单文件交接范围均可确认
- 当前状态：`STOPPED_AND_FROZEN_FOR_MACHINE_TRANSFER`

### Integration apply-owner

- generation：6
- task/thread ID：`019f7774-d842-7a20-b9a9-88322de1dc1c`
- branch：`codex/routego-integration-g6`
- worktree：`C:\Users\MLTZ\.codex\worktrees\d0dd\生图插件`
- clean HEAD：`34fd18aca083199028b8f9a54f8fc26f023711db`
- checkpoint parent：`b2b1b556a0d66f4d9bdb912eade1109f046cecad`
- checkpoint semantics：`NON_COMPLETION_WIP_SAFETY_CHECKPOINT_ONLY`
- observableCompactions：1
- 当前状态：`STOPPED_AND_FROZEN`

### 连续性自动化

- automation ID：`routego-program-continuity`
- 旧电脑配置：`C:\Users\MLTZ\.codex\automations\routego-program-continuity\automation.toml`
- prompt version：`ARCHIVE_EARLY_V5`
- 原间隔：30 分钟
- 当前运行时状态：`PAUSED`
- 暂停后的 `updated_at`：`1784426035372`
- 暂停原因：用户要求停止所有工作并跨电脑迁移
- 新电脑不得直接使用旧 seed 重新启用。必须先创建/确认新的 Controller task、worktree、generation 和精确 seed，再由新 Controller 显式更新并启用。

## 3. Git 迁移事实

本机仓库没有配置 Git remote；`git remote -v` 为空。因此另一台电脑不能直接 fetch 这里的本地 Controller/Integration 分支。

交接完成后会在仓库外生成：

- Git bundle：`routego-image-cross-computer-handoff-2026-07-19.bundle`
- SHA-256 sidecar：`routego-image-cross-computer-handoff-2026-07-19.bundle.sha256`

这两个文件位于当前 Codex task 的 visualization 目录，必须与本文件一起复制到新电脑。bundle 只包含 Git 已提交内容，不包含本机凭证、自动化运行时配置、未提交文件或真实用户数据。

新电脑恢复示例：

```powershell
git clone <复制后的bundle绝对路径> 生图插件
Set-Location 生图插件
git branch -a
git switch codex/routego-controller-g7
git status --short --branch
```

预期：能看到 `codex/routego-controller-g7` 和 `codex/routego-integration-g6`，Controller 分支 clean。不要只复制普通工作目录而漏掉 `.git`；优先使用 bundle。

## 4. Controller 关键提交链

从新到旧：

1. `6e7ad6c17258949397b2050b5aa002daff799c73`：独立授权 PD-012 Creation 精确两文件修复；task 4.3 仍锁定。
2. `2aa21f5e2d175f92b330665563dcb9af5fd6ecfb`：独立接受 operation-aware PD-012 三文件规划修订。
3. `87fc8297543bce78bb7f781d321003dff1dd395f`：激活 Controller G7 权威。
4. `e3011075146317423f80e2b5587ba8d281ee444d`：注册 Controller G7 交接。
5. `5230567298c8af902a87e70e32ed24a6dc9f9d3e`：授权 task 4.3 MCP 投影规划。
6. `a0b4b62620ef9c2ce7db5879b92d1c2698e7953a`：激活 Integration generation 6。

Controller 分支当前没有包含最新 Integration 产品 WIP；产品 WIP 位于 Integration 分支。

## 5. Integration 关键提交链

从新到旧：

1. `34fd18aca083199028b8f9a54f8fc26f023711db`：跨电脑迁移的非完成 WIP 安全检查点，仅保存两文件后续修复现场。
2. `b2b1b556a0d66f4d9bdb912eade1109f046cecad`：被 G7 拒绝的首次 Creation 两文件修复；存在三项 P1 安全泄漏。
3. `244e50084e575acfe5fa1fff6af20bfa9547cdf6`：纳入 Controller 的 PD-012 修复授权治理。
4. `2b62dac6d86c8ca0fef6b52eea81019ba5749430`：被 G7 接受的 operation-aware OpenSpec 三文件一致性修订。
5. `768bb0db6e44aaee29c645ef8e09ae5efc61c537`：首次 PD-012 三文件规划提交；后因语义冲突被要求修订。
6. `4f9cce26f6608c25679cd4b3639c72b52d65b59c`：task 4.3 原四文件非完成 WIP 安全检查点。

已接受的 task 4.2 证据链继续有效：

- Phase A：`6da30fb3d0a7920120c8f565697370d79a02e2d9`
- HTTP host correction：`3e04958f145f2207cc6bdf369af6198eedfb71b2`
- task 4.2 implementation：`60df6b9a6fdb7587171b893e2a658d25ade17bdd`
- task-state：`7ba03291adf26c28ac84abfe8cd5a8f5794ea089`
- lane checkpoint：`5cbf49bd01d6016e3ed9daf54e8d03169a8f62bf`

## 6. OpenSpec 当前进度

- change：`integrate-routego-image-plugin`
- total：29
- completed：17
- completed IDs：1.1、1.2、1.3、1.4、1.5、2.1、2.2、2.3、2.4、2.5、3.1、3.2、3.3、3.4、3.5、4.1、4.2
- next：4.3
- 4.3 状态：未勾选、未完成、WIP 已保存、产品锁定

剩余 IDs：4.3、5.1、5.2、5.3、6.1、6.2、6.3、7.1、7.2、8.1、8.2、9.1。

外部批准门禁：

- 7.2：真实 relay 验收，需要新的用户明确批准具体凭证、费用、请求类别/数量/预算和证据位置。
- 8.2：真实安装/marketplace/cachebuster/release，需要新的用户明确批准目标、停机、备份和回滚。
- 9.1：最终完整 gate，依赖前述外部任务实际完成。

## 7. task 4.3 与 PD-012 的准确状态

### task 4.3 原范围

允许的 Integration 文件只有：

- `packages/integration/src/runtime/mcp-process.ts`
- `packages/integration/src/cli.ts`
- `packages/integration/src/index.ts`
- `packages/integration/test/mcp-process.test.ts`

这些文件的非完成 WIP 已在 `4f9cce...` 保存。当前不得编辑、提交或恢复，直到 Creation common-root 修复被 Controller 独立接受并形成恢复治理。

### PD-012 根因

Creation 的 `RoutegoMcpServer` 在服务结果通过公共 Schema 后，又把整个成功结果交给诊断脱敏器。`routego_open_studio` 的一次性 token 因此被改成 `?[REDACTED]`，返回内容不再满足 `routegoOpenStudioResultSchema`，Studio 无法启动。

### 已接受规划

提交 `2b62dac...` 已明确：

- 非图片成功结果保持冻结输出 Schema-valid；Studio URL 保留当次一次性 token。
- generate/edit/batch 的文本是无图片载荷的元数据投影，不要求去载荷后的图片文本重新通过原 image-result Schema。
- 保留非载荷字段、真实路径、artifact metadata、relationships 和 truthful failure facts。
- pathless dataUrl-only artifact 继续保持 pathless，不伪造路径。
- 最终图片字节只通过 MCP image content 返回。
- 错误、异常、framing、logger、Authorization、凭证、查询参数、路径和二进制诊断继续递归脱敏。

### 当前精确 Creation 修复范围

只允许：

- `packages/creation/src/runtime/mcp/server.ts`
- `packages/creation/test/mcp.test.ts`

任何其他产品、OpenSpec、治理、Contracts、Foundation、Integration、Studio、Library、依赖或锁文件修改均未授权。

## 8. 被拒绝提交 `b2b1b55...` 的三项 P1

### P1-1：路径泄漏

首次修复的路径正则遇到空格会提前结束，并漏过部分相对路径和 POSIX `file://` 路径。

已复现：

- `C:\Users\Synthetic User\private\image.png` 只隐藏前半段，尾部仍泄漏。
- `/home/Synthetic User/private/image.png` 只隐藏前半段，尾部仍泄漏。
- `file:///home/synthetic/project/server.ts` 原样保留。
- Windows 相对路径可能未完整隐藏。

### P1-2：数字字节数组泄漏

`routegoServiceErrorSchema.details` 允许任意嵌套值。通用脱敏器会隐藏 typed array，但普通 `details.bytes=[137,80,78,71,...]` 数字数组会逐项复制，可能进入 MCP 文本或 logger。

### P1-3：自由字符串中的图片载荷泄漏

首次修复只按键名删除 `dataUrl`。合法 prompt、label 或 invariant 如果包含 `data:image/...;base64,...`，会通过 requested/effective params 原样回显。

这三项均是安全验收阻断，不得因普通测试全部通过而忽略。

## 9. 最新 WIP 安全检查点 `34fd18a...`

### 语义

- 类型：`NON_COMPLETION_WIP_SAFETY_CHECKPOINT_ONLY`
- 父提交：`b2b1b556a0d66f4d9bdb912eade1109f046cecad`
- 精确文件：Creation 的 `server.ts` 与 `mcp.test.ts`
- Git：clean
- 不代表修复完成
- 不代表 G7 已接受
- 不得据此恢复 task 4.3

### WIP 声称尝试处理

- 结构化和自由文本中的 Windows/POSIX/relative/file URL 路径，含空格和 Unicode。
- `bytes`/binary 诊断数字数组。
- 任意字段中的图片 payload，而不只 `dataUrl` 键。
- 非图片输出保持不变的回归。

这些内容尚未由 G7 独立安全复审，不得把“已写代码”当成“已修复”。

### 在停止前已经通过

- fresh OpenSpec apply status：17/29，task 4.3 未勾选。
- Creation MCP focused：12/12。
- Creation full：79/79。
- Creation typecheck/build。
- Integration `mcp-process` regression：1/1。
- Integration full：182/182。
- Integration typecheck/build。
- exact two-file scope 和 `git diff --check`。

### 尚未完成

- root `pnpm typecheck`
- root `pnpm build`
- root `pnpm test`
- `node scripts/check-package-exports.mjs`
- `node scripts/check-repository-safety.mjs`
- `openspec validate --all --strict --no-interactive` 最终复跑
- post-checkpoint Integration handoff validator
- G7/新 Controller 独立代码与安全复审
- 修复接受治理

## 10. 新电脑接管前的 12 文件低上下文启动清单

新 Controller successor 严格按下列顺序完整读取，最多 12 文件、120 KiB normalized UTF-8：

1. `AGENTS.md`
2. `.codex/routego-program/authority-summary.md`
3. `.codex/routego-program/program.json`
4. `.codex/routego-program/threads/controller.json`
5. `.codex/routego-program/handoffs/controller-generation-7.capsule.json`
6. `.codex/routego-program/threads/integration.json`
7. `.codex/routego-program/tasks/integration-4.3.json`
8. `.codex/routego-program/handoffs/integration-generation-6.capsule.json`
9. `.codex/routego-program/deviations/PD-006-context-handoff-threshold.md`
10. `.codex/routego-program/deviations/PD-008-low-context-lossless-handoff.md`
11. `.codex/routego-program/deviations/PD-012-task-4.3-creation-mcp-public-success-projection.md`
12. `.codex/routego-program/handoffs/controller-generation-7-machine-transfer.md`

本清单 normalized UTF-8 总量：`94,825 bytes`（CRLF/CR 统一规范化为 LF 后计算），低于 `120 KiB` 上限。

默认不得读取全部 main specs、全部 archived changes、旧完整线程历史或无关 evidence。只有身份/Git/capsule/OpenSpec/安全状态不一致时才定向展开。

## 11. 新电脑推荐接管顺序

1. 从 bundle 恢复仓库，确认两条分支和 commit 可达。
2. 在 Controller 分支确认本交接文件所在 HEAD、`git status` clean。
3. 创建全新的 Controller successor task/worktree/branch，建议 generation 8；不要把旧 G7 task 当作仍在运行。
4. 按第 10 节完成 12 文件低上下文审计；出现任何压缩/身份/哈希/预算不一致，停止并报告。
5. 由用户或可访问的旧 G7 完成新 Controller 的明确 authority transfer；在激活前不得管理产品工作。
6. 新 Controller 为 Integration 创建/接管新的 successor，起点必须精确为 `34fd18aca083199028b8f9a54f8fc26f023711db`，并重复 PD-008、双路径回报和外部安全门禁。
7. 新 Integration successor 先只读复审 `34fd18a...` 相对 `b2b1b55...` 的两文件差异，逐项验证三类 P1，而不是先继续改代码。
8. 运行第 9 节尚未完成的全部门禁，并重新确认已运行的聚焦测试。
9. 如果发现问题，只能继续修改同两个 Creation 文件；不得改 Foundation/Contracts 来迁就实现。
10. 如果 WIP 真实通过，必须在 `34fd18a...` 之上创建新的后续完成提交；不得 amend/rebase/rewrite `b2b1b55...` 或 `34fd18a...`。
11. 将新提交、父提交、精确范围、测试、Git clean 和残余风险直接回报新 Controller，并 `read_thread` 回读。
12. 只有 Controller 独立接受 Creation 修复并提交 task 4.3 恢复治理后，才允许继续原四文件 WIP。

## 12. 新电脑需要运行的检查命令

以下命令在新电脑的 Integration worktree 根目录运行。命令都只用于读取或离线验证；不得配置真实凭证或联网。

```powershell
git status --short --branch
git rev-parse HEAD
git show --stat --oneline 34fd18aca083199028b8f9a54f8fc26f023711db
git diff --check b2b1b556a0d66f4d9bdb912eade1109f046cecad 34fd18aca083199028b8f9a54f8fc26f023711db
openspec instructions apply --change integrate-routego-image-plugin --json
pnpm --filter @routego-image/creation typecheck
pnpm --filter @routego-image/creation test
pnpm --filter @routego-image/creation build
pnpm --filter @routego-image/integration typecheck
pnpm --filter @routego-image/integration test
pnpm --filter @routego-image/integration build
pnpm typecheck
pnpm build
pnpm test
node scripts/check-package-exports.mjs
node scripts/check-repository-safety.mjs
openspec validate --all --strict --no-interactive
node .codex/routego-program/scripts/validate-handoff-capsule.mjs .codex/routego-program/handoffs/integration-generation-6.capsule.json
git diff --check
git status --short --branch
```

注意：旧 capsule 的 current Integration HEAD 可能仍记录规划/治理安全点，而实际迁移 WIP HEAD 是 `34fd18a...`。新 Controller 必须先建立新的 successor/治理状态，不能为了让旧 validator 通过而伪造或回退 Git。

## 13. 明确禁止

- 不得把 `34fd18a...` 标为完成。
- 不得勾选 task 4.3。
- 不得继续 5.1 或更后任务。
- 不得修改七个工具或公共 phase。
- 不得把失败测试删掉、降低阈值或吞掉异常。
- 不得用 fake path、fake token、假成功、Integration wrapper、重复 MCP server 或 schema weakening 绕过问题。
- 不得重写共享历史。
- 不得重新启用旧电脑自动化 seed。
- 不得接触真实凭证、用户图片、真实 Library/relay、网络、付费请求、安装、marketplace、部署、发布、迁移、删除或 release。

## 14. 最终交接状态

- Controller：clean、冻结、等待新电脑 successor。
- Integration：clean、冻结、WIP 安全检查点已提交。
- OpenSpec：17/29，4.3 未完成。
- 自动化：旧电脑运行时已暂停。
- 外部状态：除暂停连续性自动化外未触碰。
- 部署/发布：未执行。
- 真实数据/费用：未触碰、未产生。
- 下一责任人：新电脑上的新 Controller successor 与新 Integration successor。
