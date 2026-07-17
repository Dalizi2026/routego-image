# Routego Image 旧插件兼容基线

本文件把 `docs/audits/legacy-plugin-audit.md` 的事实证据转换为 Routego Image 1.0 Foundation 必须冻结的外部契约。旧插件目录 `C:\Users\MLTZ\plugins\routego-image` 只作为只读证据源，不迁移、不修改、不删除，也不复制进本仓库。

## 保留的兼容事实

- 插件名保持 `routego-image`。
- 旧版 API Base 兼容模式可按明确规则得到 `/v1/images/generations`。
- Tier A 文本请求形状为 JSON `{ model, prompt, n, size }`。
- Tier A 单图兼容形状是在同一个 generations JSON 中增加 `image: data:image/...;base64,...`。
- 同步结果至少兼容 `data[].b64_json` 和 `data[].url`，但必须重新实现大小、类型、超时与凭证策略。
- 只使用当前请求结构化返回的结果，不扫描目录或复用旧文件冒充当前结果。
- 批量结果必须逐项保留成功与失败事实。
- 配置和结果展示只返回统一的短预览与脱敏信息。

以上事实只证明旧快照的行为，不证明真实中转当前支持图片输入、`images[]`、Edits、Responses、非标准尺寸或原生 `n`。

## FZ-01～FZ-12 映射

| ID | Foundation 冻结决定 | 后续主要责任泳道 |
|---|---|---|
| FZ-01 | 端点输入区分 `exact-generation-endpoint` 与显式 `legacy-api-base`；models/edits/responses URL 独立可空且不自动派生；只允许安全 HTTP(S) URL | Foundation / Creation / Library |
| FZ-02 | 能力按 provider、model、endpoint、transport 和请求形状独立记录四态与证据；单图和多图分开 | Foundation / Creation |
| FZ-03 | 内部统一请求不暴露旧 CLI；Tier A 文本和单 `image` fixture 固定，`images[]` 需单独验证 | Foundation / Creation |
| FZ-04 | `variantCount` 与 batch 分离；fan-out 显式记录降级、attempt 和 provider request 数 | Foundation / Creation |
| FZ-05 | 连接/响应头、正文、下载和总任务截止时间分阶段；仅预生成 429/5xx 最多两次退避，不跨 adapter 重放 | Foundation 契约 / Creation 实现 |
| FZ-06 | Base64、URL、同步 JSON、SSE/Responses 分层解析；结果 URL 默认不转发 provider Authorization；逐输出保留 partial | Foundation 契约与安全 / Creation 实现 |
| FZ-07 | 临时文件、校验、原子改名、真实扩展名、版本化排他创建；成功文件不得成为未报告孤儿 | Foundation 契约 / Library 实现 |
| FZ-08 | target、supporting、references、mask 独立字段；mask 永远绑定 slot 0，并在发送前完成文件与 alpha 校验 | Foundation 契约 / Creation 与 Studio |
| FZ-09 | 新配置只写 `~/.codex/routego-image/config.json`；旧文件不迁移；Key 禁止进入参数、日志、元数据和返回 | Foundation 安全 / Library 实现 |
| FZ-10 | 冻结结构化错误类别、阶段、状态、重试处置、partial 和收费风险；原始正文只允许限长脱敏诊断 | Foundation / Creation |
| FZ-11 | 插件资源只使用相对根或运行时资源路径；淘汰 `~/plugins` 硬编码和 stdout marker + `process.exit()` 协议 | Foundation 边界 / Integration |
| FZ-12 | JSON、stdio、配置、索引和文本统一 UTF-8；覆盖中文、emoji、空格路径与跨平台换行 | Foundation 测试 / 全泳道 |

## 必须淘汰的旧行为

- 无条件给任意图片结果 URL 转发 provider Bearer 凭证。
- 从唯一端点自动猜测 `/models`、`/images/edits`、`/responses` 或其他路径。
- 公开 `--set-key <key>` 参数、普通 JSON 覆盖写入和吞掉损坏配置。
- 把任意本地文件按扩展名伪装成 PNG data URL。
- 响应头到达后取消超时，正文/下载/写盘无限等待。
- 把一个提示词的多个变体伪装成多个独立 `n:1` 请求而不报告真实请求数。
- 无能力状态却无条件宣称编辑可用。
- 一律保存为 `.png`、不校验 MIME/魔数/大小、可能覆盖或产生孤儿文件。
- 通过 `ROUTEGO_RESULT_JSON` stdout 标记和强制 `process.exit()` 判断业务成功；Windows 已复现成功后异常退出导致重复收费风险。

## 验收延后项

以下事实只能在 Integration 的用户确认真实中转验收中确定：Tier A `image/images` 方言、原生 `n`、Edits multipart、Responses IDs/SSE、真实尺寸/质量参数、复杂透明背景、Base64/URL 响应方言和收费行为。Foundation 必须把它们表示为 `unknown`，不能用 mock 或审计推断为 `supported`。
