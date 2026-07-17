# Creation generation 1 交接清单

## 身份与原因

- 泳道：`creation`
- OpenSpec change：`add-routego-image-creation`
- 来源任务：`019f7084-17c4-7442-94e5-458f59b20086`
- 来源代次：`0`
- 继任任务：`pending`
- 继任代次：`1`
- 计划分支：`codex/routego-creation-g1`
- 可观察上下文压缩：`2`
- 原因：连续性治理到达时大型原子任务 `3.2` 已在执行；来源任务完成、验证并提交该任务后发送 `[LANE_CHECKPOINT]`，不得继续启动大型任务 `4.1`。

## 安全基线

- 来源 worktree：`C:\Users\MLTZ\.codex\worktrees\76ae\生图插件`
- 来源分支：`codex/routego-creation`
- 产品/OpenSpec 安全提交：`2efb2465fa92fc51b4f6bf5f744a29a320b62a63`
- 任务 3.2 实现提交：`41f7c2b49a6d0483c82551d457cfb9349ec11a13`
- Git：干净
- OpenSpec：`6/8`
- 已完成：`1.1`、`1.2`、`2.1`、`2.2`、`3.1`、`3.2`
- 下一任务：`4.1`
- 剩余：`4.1`、`5.1`

## 最近验证

- 新鲜 `openspec instructions apply --change add-routego-image-creation --json`
- Creation typecheck
- HTTP 聚焦测试 `7/7`
- Creation 累计测试 `68/68`
- `pnpm safety`：190 个跟踪文件
- 单 change strict OpenSpec
- `git diff --check`
- 暂存范围审计

## Apply-owner 互斥与启动门禁

- 本交接提交后，来源任务暂停 apply 权限，不得启动 `4.1` 或修改产品/OpenSpec。
- 继任任务在真实登记前只读；任何写入前必须完整重读权威文件，并运行：
  - `openspec status --change add-routego-image-creation --json`
  - `openspec instructions apply --change add-routego-image-creation --json`
- 继任任务登记后创建 `codex/routego-creation-g1`，核对 6/8、下一任务 4.1 和 Git 清洁，向 Controller `019f715f-c042-7590-a38b-ffb406315903` 发送 `[CREATION_HANDOFF_ACCEPTED]`。
- 旧任务归档、Controller 激活唯一 owner 后，继任任务才可从 `4.1` 继续，不得重做已完成任务。

## 连续性与范围

- change 未完成时，final/idle 前必须实际发送结构化 lane 消息。
- 第二次压缩的大型下一任务使用 successor；第三次压缩仍强制新任务/new worktree。
- 不改变七个公共 MCP 工具，不解析 Library/upload filesystem locator，不接触真实凭证、图片、图库、真实中转或计费探测，不跨 Library/Studio/Integration/发布所有权。
