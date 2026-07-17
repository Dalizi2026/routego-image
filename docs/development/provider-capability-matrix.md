# Routego Image Provider 能力矩阵

本文件定义中转适配器的能力模型。任何实现线程不得默认中转存在 `/images/edits`、`/responses`、`/models` 或其他派生路径。

## 当前已知环境

- 用户持有一个 API Base/生图端点和 API Key。
- 本地配置中的 API Base 为已配置状态，模型缓存只有 `gpt-image-2`。
- 旧插件将 API Base 规范化为 `/v1/images/generations`。
- 文生图请求：JSON `{ model, prompt, n, size }`。
- 旧插件的图生图/编辑请求：仍向 generations 端点发送 JSON，并增加单个 `image` data URL。
- 上述行为说明“单端点图片扩展”是必须保留的兼容路径，但不等于已经证明所有模型和请求都支持编辑。

不得在文档、日志或测试固件中保存真实 API Key。

## 能力状态

每个 provider/model/endpoint 组合分别记录：

- `unknown`：未验证；默认状态。
- `supported`：通过明确成功响应、供应商文档或用户配置确认。
- `unsupported`：收到稳定的协议级不支持响应，或供应商明确声明不支持。
- `degraded`：能完成近似工作流，但语义、状态连续性或参数能力弱于标准实现。

鉴权失败、限流、超时、5xx 和 moderation block 不得直接写成 `unsupported`。

## 传输适配器

| 适配器 | 请求方式 | 主要能力 | 启用条件 |
|---|---|---|---|
| `single-endpoint-json` | 唯一端点 JSON | 文生图；可选 `image/images` data URL 图生图 | 默认启用文生图；图片输入必须单独验证 |
| `openai-images` | generations JSON + edits multipart | 标准生成、多参考图、遮罩编辑 | 明确确认 edits URL 可用 |
| `openai-responses` | Responses + image_generation tool | 多轮状态、action、image/file/response ID、流式中间图 | 明确确认 Responses 可用 |

## 必须独立记录的能力

- 文本生成
- 单图输入
- 多图输入及最大数量
- 目标图编辑
- 遮罩编辑
- 画布扩展/外绘
- 同提示词多结果 `n`
- 自定义尺寸
- `low/medium/high/auto` 质量
- PNG/JPEG/WebP 与压缩率
- 流式和 0～3 张中间图
- 原生透明背景
- moderation 参数和结构化错误
- Responses 多轮状态
- 图片 URL、Base64、data URL、multipart、file ID 和 image ID

`routego_status` 返回脱敏后的能力矩阵、验证时间、验证来源和降级说明。

## 路由规则

1. 用户未提供输入图：调用已验证的文本生成路径。
2. 用户提供参考图或编辑目标：优先选择已验证支持图片输入的适配器。
3. 只有单端点图片扩展可用：使用 data URL，并在结果中记录 `transport=single-endpoint-json`。
4. 没有任何图片输入能力：返回结构化 `capability_unavailable`，保留任务草稿但不发送伪造请求。
5. 遮罩只应用于第一张目标图；其余图片均为支持/参考输入。
6. 多轮编辑没有 Responses 状态时，将上一结果重新作为目标图，并标记 `degradedContinuation=true`。
7. 超时、429/5xx 或部分结果后不得切换适配器重放同一请求，避免重复收费。

## 能力验证

- 端点字符串和 models 列表只能提供候选信息，不能证明图片编辑能力。
- HEAD/OPTIONS 结果不可靠，不作为唯一依据。
- 首次真实图片输入测试可能产生费用，必须由用户主动发起编辑/图生图请求，或在 Studio 明确确认测试。
- 成功测试保存脱敏请求形状、状态码、响应形状和验证时间，不保存图片内容或认证头。
- 用户可清除能力缓存并重新验证。

## 官方 ImageGen 对齐与降级

- 标准完整路径：生成、多个参考图、遮罩编辑、多轮 Responses、流式中间图、输出格式和 moderation。
- 单端点扩展路径只要支持图片输入，也应提供图生图、直接编辑和外绘，但必须标记具体缺失能力。
- 仅文本端点无法实现真实编辑。插件应禁用提交按钮并清楚说明中转限制，不得用本地滤镜冒充模型编辑。
- `gpt-image-2` 原生透明背景不可用；首选色键加本地去背。复杂透明素材需要明确确认其他可用模型/参数。
