# gpt_image_playground 来源与复用边界

## 固定来源

- 上游：`CookSleep/gpt_image_playground`
- 固定提交：`a10477581b3d43ac98d39777e4445625a9db113d`
- 提交时间：2026-07-15T20:14:15+08:00
- 上游版本：0.7.0
- 许可证：MIT
- 版权所有者：Copyright (c) 2026 CookSleep
- 证据：`docs/audits/gpt-image-playground-reuse.md`
- 审计文档提交：`4b7909579f382cc1fec5ac79172a0aeeb3d70923`

升级固定提交前必须重新完成代码、许可证、依赖和安全审计，不能把本文件自动套用于其他 SHA。

## 允许理解后抽取或重构

以下范围只批准“理解后抽取和重构”，不批准整文件或整应用直接复制：

- 遮罩目标置首、alpha 覆盖分类、空遮罩拒绝等纯逻辑。
- 画布缩放、平移、指针坐标映射等纯函数。
- 尺寸字符串解析和像素预算计算方法；所有常量必须改由 Routego capability policy 决定。
- 透明色键像素处理核心；必须增加资源限制、后处理失败状态和复杂素材验收。
- SSE block reader 与 Images/Responses 事件 fixture；必须重写为 Routego 结构化事件和错误。
- Images generations JSON、Edits multipart 顺序、Responses tool/input 构造的协议思路；端点与字段启用必须经过能力门禁。
- 图库、收藏夹、批量选择、遮罩编辑器的产品交互语义；数据事实来源仍是 Routego 本地服务和版本化 JSON 索引。

任何实质性派生文件都要注明：来源仓库、固定 SHA、修改范围，并链接 `THIRD_PARTY_NOTICES.md`。

## 禁止移植

- Agent UI、多工具循环、Web 搜索和 Markdown/Agent 展示依赖。
- fal.ai、自定义云供应商、轮询型云 API。
- 赞助页面、PWA、Cloudflare/Vercel/Wrangler 等云部署能力。
- 上游 `App.tsx`、5658 行单体 store、IndexedDB 数据层、完整组件骨架。
- 上游 `package-lock.json`、Vite/构建配置、依赖树、`dist` 或其他构建产物。
- 自动拼接 `/images/edits`、`/responses` 或其他兄弟端点的 URL 逻辑。
- 把浏览器 localStorage/IndexedDB 中的 API Key 或设置导出到 ZIP 的行为。

## Routego 自有实现要求

- Tier A `single-endpoint-json` 必须新建，不能由上游 Images adapter 冒充。
- Tier B Edits 和 Tier C Responses 仅在明确配置或验证后启用。
- Responses 的 previous response、file/image IDs 和 provider IDs 必须由 Routego 独立建模。
- 收藏夹使用资产级多对多关系；删除使用软删除、恢复、30 天保留和二次确认。
- ZIP 导入重新实现 Schema、路径、大小、条目数、SHA-256、MIME/魔数和膨胀率校验。
- 依赖及其许可证以 Routego 自己的 `pnpm-lock.yaml` 和发布产物为准。
