# Library generation 1 交接清单

- 泳道/change：`library` / `add-routego-image-library`
- 来源任务：`019f7084-17ce-75d0-932b-12878f95f48f`，generation 0，observableCompactions 2
- 继任任务：`019f71ed-2149-73c2-851d-368a54c1ed5b`，generation 1
- 计划分支：`codex/routego-library-g1`
- 继任 worktree：`C:\Users\MLTZ\.codex\worktrees\8c92\生图插件`
- 交接治理起始提交：`d5fc0c3ed7cb5f006c124203e100627064d8c65f`
- 来源 worktree：`C:\Users\MLTZ\.codex\worktrees\f5a6\生图插件`
- 产品/OpenSpec 检查点：`15775de3354cd49a256f95cbe06261e779a3e19d`
- 任务 3.1 实现：`eb111efbcdd2fb20317bd78725512edd10458ba7`
- OpenSpec：`4/10`；完成 `1.1,1.2,2.1,3.1`；下一任务 `3.2`；剩余 `3.2,3.3,4.1,4.2,5.1,5.2`
- Git 干净；最近验证包含 Library typecheck、70/70 测试、build、safety、OpenSpec strict 7/7、diff/scope/敏感数据审计。
- 本交接提交后来源任务暂停 apply；继任登记前只读。
- 继任任何写入前完整重读权威文件，并运行 `openspec status --change add-routego-image-library --json` 与 `openspec instructions apply --change add-routego-image-library --json`。
- 继任登记后创建 `codex/routego-library-g1`，确认 4/10、下一任务 3.2、Git clean，并发送 `[LIBRARY_HANDOFF_ACCEPTED]`。
- 旧任务归档和 Controller 激活前 activeOwnerThreadId 保持 null；之后 successor 才能从 3.2 继续。
- 不修改公共 MCP 工具、共享契约、根依赖/锁文件、Creation/Studio/Integration/发布文件；不接触真实密钥、用户图片、图库或中转。
