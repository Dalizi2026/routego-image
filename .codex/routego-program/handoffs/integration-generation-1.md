# Integration generation 1 交接清单

## 身份与治理起点

- 泳道/change：`integration` / `integrate-routego-image-plugin`
- 来源任务：`019f72fd-fb6f-7b52-b383-03471f42f05a`，generation 0
- 继任任务：`pending`，generation 1；由 Controller 创建并回填真实 thread ID
- 来源 worktree：`C:\Users\MLTZ\.codex\worktrees\4687\生图插件`
- 来源分支：`codex/routego-integration`
- 来源安全 checkpoint：`737bd0789b228a29ab0c75251be97d07261b54a4`
- 计划继任分支：`codex/routego-integration-g1`
- 继任 worktree：`pending`；必须是 Controller 从本治理交接提交创建的全新隔离 worktree
- Controller 任务：`019f7309-d473-74a2-934b-e81726d90a31`
- Controller 分支：`codex/routego-controller-g3`
- Controller 治理 checkpoint：`270e61afafd79e22ec1e9ec4917ae6820fcad304`
- 本交接治理提交：由当前文件与 `threads/integration.json` 的唯一治理提交形成；完整 SHA 通过 `[INTEGRATION_HANDOFF_READY]` 和 successor registration 传递，不在提交内自引用。

## OpenSpec 与提交状态

- OpenSpec schema：`spec-driven`
- OpenSpec progress：`1/28`
- 已完成任务：`1.1`
- 下一任务：`1.2`
- 1.1 实现提交：`0abce8690a35014b80aa8a5f93188ce08fca0608`
- 1.1 sole-owner task-state 提交：`5a7cfedbe6f44b402a9d253c475c46869bed6a0d`
- generation 0 连续性 checkpoint：`737bd0789b228a29ab0c75251be97d07261b54a4`
- Controller 批准合并提交：`adf58553abfba931e449388cf78c6b20ccc23076`
- offline apply 激活提交：`ece7e5a4018a4b7277df046e4032e71247c922a8`
- 批准规划工件提交：`dd02ccfb03b53034afb9314de4fa8441a3846441`
- 批准规划 delivery HEAD：`fbd051f42f9649d6c3d88687a6abe8edde99d38e`
- apply 授权：任务 `1.1` 到 `7.1` 以及 `8.1` 的离线实现仍按依赖顺序有效，但 successor 未接管并成为唯一 apply owner 前禁止任何新实现。
- 未授权：`7.2` 真实中转、`8.2` 安装/marketplace/部署/发布、`9.1` 最终完成。

## 任务 1.1 已交付内容

- `packages/contracts/src/library.ts`
  - 新增 Library-only `source | partial | final` rendition phase。
  - Library asset detail rendition 上限固定为 33。
  - 增加 `primaryArtifactId`，拒绝 source primary，成功资产要求 final primary/final rendition。
  - 校验本资产 relationship artifact 的准确 ownership，并要求 output relationship 使用准确 artifact ID。
  - 公共 `ImageArtifact.phase` 保持 `partial | final`。
- `packages/contracts/test/library-service.test.ts`
  - 覆盖 mixed source MIME、17+12+4=33、34 拒绝、source primary、成功无 final、owner 错配、browser-safe 输出和精确七工具冻结。
- `openspec/changes/integrate-routego-image-plugin/tasks.md`
  - 仅由 generation 0 apply-owner 在实现提交和验证完成后勾选 1.1，并记录完整实现 SHA。
- `.codex/routego-program/threads/integration.json`
  - 记录 apply 激活、第二次压缩、1.1 提交和 generation 1 交接门禁。

## 下一任务 1.2 的精确边界

- 目标：实现一个预分配 operation asset 上 source/output 共摄取、mixed source MIME、output-only primary/final、不超过 33 个 renditions、准确 relationship ownership、解析/损坏拒绝以及 detail/resource projection。
- 允许文件：
  - `packages/library/src/gallery/model.ts`
  - `packages/library/src/gallery/assets.ts`
  - `packages/library/src/gallery/read-service.ts`
  - `packages/library/test/gallery/source-renditions.test.ts`
- 禁止文件：无关 query/folder/mutation/upload/config、ZIP、Creation、Studio、root 文件，以及超出 1.1 的公共 schema 修改。
- 实现前必须重新运行 `openspec status --change integrate-routego-image-plugin --json` 和 `openspec instructions apply --change integrate-routego-image-plugin --json`，核对进度仍为 1/28、下一任务仍为 1.2、Git clean、精确文件所有权和验证命令。
- 验证要求：Library typecheck/build；focused mixed PNG/JPEG/WebP source/output、primary、succeeded/partial、33/34、dedupe、exact owner、corrupt index、detail/resource、traversal/legacy；截至当时的完整 Library 测试；`pnpm safety`；`git diff --check`；精确范围审计。

## 冻结契约与不可变决策

- 公共 MCP 工具精确保持七个：`routego_status`、`routego_generate`、`routego_edit`、`routego_batch`、`routego_search_library`、`routego_manage_library`、`routego_open_studio`。
- 公共 `ImageArtifact.phase` 精确保持 `partial | final`；`source` 仅属于 Library rendition。
- Library graph 上限保持 `17 source + 12 partial + 4 final = 33`。
- chromakey 只使用一个既有 output identity，不增加 rendition 或 relationship role。
- Studio stream 唯一路由保持 `POST /api/v1/studio/creation/stream`，并保持 first/unique started、requestId 一致、严格递增 sequence、唯一 terminal、terminal-before-EOF、无 sentinel。
- ephemeral descriptor expiry 保持不可变的 `min(registration + 5 minutes, owning session expiry)`；stream/UI cleanup 不得提前撤销 server descriptor。
- 不得删除、迁移或覆盖旧插件、旧配置、旧图库或用户数据。

## 已运行验证

- 1.1 focused contracts：`18/18` 通过。
- contracts 全量：`7` 个测试文件、`96/96` 通过。
- contracts typecheck：通过。
- contracts build：通过。
- `openspec validate --all --strict --no-interactive`：`19/19` 通过。
- repository safety：通过，检查时 `385` 个 tracked files。
- `git diff --check`：通过。
- 精确范围审计：1.1 实现提交只修改两个授权合同文件；task-state 提交只修改 `tasks.md`；generation 0 checkpoint 只修改 Integration 线程治理状态。
- 最近只读复核：HEAD `737bd0789b228a29ab0c75251be97d07261b54a4`、OpenSpec `1/28`、Git clean、1.2 未开始。

## 未运行与外部边界

- 未执行 1.2 或任何后续产品任务。
- 未使用真实 API Key、Authorization、用户图片、真实 Library 或真实 relay。
- 未执行 billable probe/request、真实中转验收、安装替换、marketplace 修改、部署、发布、迁移、删除或 release。
- 未运行 7.2、8.2、9.1，因为它们没有新鲜的用户外部授权或尚未满足依赖。

## 上下文健康与交接原因

- observable compactions：`2`
- generation 0 最后 fingerprint：`2026-07-18-compaction-2-task-1.1-checkpoint-at-5a7cfedbe6f44b402a9d253c475c46869bed6a0d`
- 最近健康审计：1.1 合同验证、实现提交和独立 task-state 提交通过；Git clean；未开始 1.2。
- 交接原因：第二次可观测压缩要求安全 Git checkpoint，而 1.2 是大型原子 Library 任务；必须在开始前交给新任务和新 worktree。

## successor 强制启动顺序

1. 完整读取 `routego-image-1.0-plan.md`、`AGENTS.md`、`.codex/routego-program/program.json`、`.codex/routego-program/threads/integration.json`、本交接文件、PD-002/003/004/005、当前 Integration proposal/design/11 delta specs/tasks、全部 18 份主规格，以及三个 archived functional changes。
2. 完整读取并使用 `openspec-apply-change`，运行 fresh status/apply instructions/strict validation。
3. 第一轮只读，核对真实 successor thread ID/worktree、planned branch、交接治理提交、OpenSpec 1/28、下一任务 1.2 和 Git clean；`pending` 是合法登记等待状态。
4. 等待 Controller 发来真实 successor registration；纳入登记治理、创建/切换 `codex/routego-integration-g1`，更新 Integration 线程状态并发送 `[INTEGRATION_HANDOFF_ACCEPTED]`。
5. 在 Controller 明确停用/归档 generation 0 并激活 generation 1 为唯一 apply-owner 前，不得开始 1.2。
6. 接管后只执行 1.2；完成验证和实现提交后，再由唯一 owner 单独更新 `tasks.md`。不得重做 1.1。

## 阻塞、残余风险与建议

- 当前治理阻塞：successor 真实 thread/worktree 尚未登记；generation 1 尚未接受交接并成为唯一 apply-owner。
- 技术阻塞：无；1.1 已验证完成。
- 残余风险：1.1 扩展了共享 Library detail contract，现有 Library persistence/read seams 仍需由 1.2 在同一原子任务内完成适配，不能在交接期间零散修改。
- 推荐下一步：Controller 从本治理交接提交创建并登记 generation 1 独立 worktree，发送 registration；generation 0 保持停止，直到收到 successor 接管确认。
