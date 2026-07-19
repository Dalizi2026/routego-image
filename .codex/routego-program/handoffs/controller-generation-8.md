# Controller generation 8 跨电脑接管入口

权威机器胶囊：`.codex/routego-program/handoffs/controller-generation-8.capsule.json`

- 冻结源：Controller G7，`a6fae7e9ea62205e61a8540d98bc45ae3f053cca`
- 源父提交：`6e7ad6c17258949397b2050b5aa002daff799c73`
- successor：Controller G8 task `019f7978-0c86-7453-af3c-f5bcd3c13da0`
- successor worktree：`/Users/dalizi/Documents/routego-image-controller-g8`
- successor branch：`codex/routego-controller-g8`
- 启动审计：12 文件，94,825 normalized UTF-8 bytes，acceptance 前零次可观测压缩
- Integration 迁移检查点：`34fd18aca083199028b8f9a54f8fc26f023711db`，仅为非完成 WIP 安全检查点
- OpenSpec：17/29；task 4.3 未完成并保持产品锁定

旧 G7/G6 task 和旧自动化只作为冻结历史来源。G8 必须先完成 registration/acceptance，再通过单独 activation 提交成为权威 Controller；随后才能建立 Integration generation 7。三类 P1 泄漏必须独立复审通过，之后才能形成 task 4.3 恢复治理。

直接 `send_message_to_thread` 后 `read_thread` 回读是主链；连续性自动化仅为漏报兜底，且在建立新电脑精确 seed 前保持暂停。外部状态、真实凭证或图片、联网/付费探测、安装、部署、发布、迁移、删除和 release 均未授权。
