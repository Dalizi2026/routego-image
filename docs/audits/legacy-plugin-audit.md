# Routego Image 旧插件审计

> 审计类型：`pre-change audit`
> 审计章节 ID：`LA-01`～`LA-10`
> 审计源：`C:\Users\MLTZ\plugins\routego-image`
> 审计日期：2026-07-17
> 边界：只读审计旧插件；未修改旧插件、产品代码、Program 登记或 OpenSpec；未读取真实 API Key、真实用户图片或真实配置内容；未发起真实生成请求。

## LA-01 一句话结论

旧插件可以作为 Routego Image 1.0 的 **Tier A 单端点 JSON 兼容证据**，但不能原样迁移为 1.0 运行时：它确实验证了 generations JSON、单个 `image` data URL、Base64/URL 同步结果和并发任务的基本路径，同时存在一个必须优先阻断的凭证泄露问题，以及端点猜测、能力误判、超时范围不完整、配置写入不安全、批量/变体语义混淆等系统性限制。

Foundation 应冻结“兼容行为的外部契约”，不应冻结旧脚本的代码结构、CLI 协议或硬编码安装路径。

## LA-02 审计基线与证据清单

旧插件只有四个业务/声明文件和一个图标，没有 MCP 服务、HTTP 服务、Studio、测试、包依赖清单或许可证文件。

| 文件 | 大小 | SHA-256 | 作用 |
|---|---:|---|---|
| `.codex-plugin/plugin.json` | 1,406 B | `e54f94e1e70f71d2d4b0100d4ce996e3ab788b64b958d34b94fdb17f097f179f` | 插件名称、版本、Skill 入口和界面文案 |
| `skills/routego-image/SKILL.md` | 12,783 B | `0b030c68f811a347d2fe05ef4a9f9c7fed6fef228f6af91ba27eb984a9d97e89` | 主要交互规则、CLI 调用流程、结果展示规则 |
| `scripts/generate.mjs` | 25,859 B | `2a93c2e908f0cc507ebf233c3aa59719f38ce685659ea49302e62e556ba50f2c` | 配置、模型刷新、生成、编辑、参考图、批量和文件保存 |
| `scripts/setup.mjs` | 9,041 B | `14656a3b5094ae9801bd75e8c0e23cb8bebccbab2444bef824ff5d90d701b039` | 本地交互式设置菜单和隐藏密钥输入 |
| `assets/logo.png` | 18,248 B | `179109cdd99c14b3f9a6e71f5f8d58f503c6f68c0fc4d7e301b07ffdd955c405` | 插件图标 |

行号均指上述哈希对应的快照。

## LA-03 Manifest 与 Skill 的实际行为

### Manifest

- 插件名为 `routego-image`，版本为 `0.1.0+codex.20260702174547`；只声明 `./skills/` 和 `Write` 能力，没有 MCP、应用或脚本生命周期声明（`plugin.json:2-18`）。
- 宣传文案无条件声称支持生成和编辑（`plugin.json:12`），但运行时没有能力状态，编辑是否可用完全取决于中转是否接受 generations 端点中的非标准 `image` 字段。
- Manifest 本身不负责定位脚本。Skill 将脚本路径硬编码到 `$USERPROFILE/plugins/routego-image` 或 `$HOME/plugins/routego-image`（`SKILL.md:10-28`），因此旧插件依赖固定个人目录，不具备 1.0 所需的自包含、可重定位安装能力。

### Skill

可复用的规则：

- 每轮先读取脱敏配置，不在聊天中索取或显示完整密钥（`SKILL.md:30-39`）。
- 只使用当前命令返回的 `ROUTEGO_RESULT_JSON.paths`，禁止扫描输出目录或复用旧结果冒充当前结果（`SKILL.md:46-48,233-256`）。
- 超时后不静默降质量重试（`SKILL.md:45,141-143,163-165,199-201`）。
- 能区分直接编辑与风格、构图、主体三类参考意图（`SKILL.md:167-197`）。
- 多源直接编辑会为每张源图重复 `--image`，并要求结果保留源图关联（`SKILL.md:145-165,239-244`）。

必须淘汰或下沉到结构化契约的限制：

- 大量正确性依赖 Agent 遵守自然语言规则，而不是运行时 Schema、能力状态和权限边界。
- 参考图生成最多一张参考图；多图时要求用户选一张（`SKILL.md:49,179-181`），无法满足 1.0 最多 16 张参考图。
- Skill 在收到 HTTP 400 或含 `image/unsupported` 的错误时只追加“可能不支持图片输入”（`SKILL.md:256-258`），没有把 provider/model/endpoint 的能力记录为 `unknown/supported/unsupported/degraded`。
- `>10` 个提示词只要求 Agent 确认（`SKILL.md:217-231`），脚本自身没有 20 个任务上限，不能作为安全边界。
- CLI 路径、回复格式、提示词包装和生成执行耦合在一个大型 Skill 中，1.0 应改为薄 Skill + MCP 结构化工具。

## LA-04 `generate.mjs` 的实际协议

### 端点 URL 规范化

`generationUrl()` 的规则是（`generate.mjs:114-123`）：

1. 去掉尾部 `/`。
2. 已以 `/images/generations` 结尾则原样使用。
3. 已以 `/v1` 结尾则追加 `/images/generations`。
4. 其他任何 URL 都追加 `/v1/images/generations`。

这能兼容旧的“API Base”输入，但不能代表“用户提供的唯一精确端点”。例如本地假中转实测，配置 `http://127.0.0.1:<port>/custom-endpoint` 后，实际请求路径变为 `/custom-endpoint/v1/images/generations`。URL 的查询串、片段、大小写、嵌入式凭证和协议也没有被规范化或禁止；设置时只调用 `new URL()` 检查是否为绝对 URL（`generate.mjs:650-663`），`file:` 等非 HTTP(S) 协议也会被接受并保存。

### Models 请求

`modelsUrl()` 同样从 API Base 猜测 `/models`（`generate.mjs:125-130`）。`refreshModels()` 对该地址发送带 Bearer 的 GET，请求没有超时、重试或响应大小限制；失败时保存最多 500 字符响应预览，成功时仅缓存包含关键字的模型（`generate.mjs:501-524`）。

模型解析兼容数组、`{data: []}`、字符串项以及对象的 `id/name`（`generate.mjs:132-143`），这个形状兼容逻辑可以重写后复用。旧过滤器使用宽泛子串，包括 `sd`、`mj`（`generate.mjs:14-24,145-149`），既可能漏掉图片模型，也可能误收非图片模型，不能作为能力证据。

### Generation JSON

所有生成、编辑和参考图都调用同一个 generations URL，固定发送 JSON（`generate.mjs:246-263`）：

```json
{
  "model": "<selected model>",
  "prompt": "<prompt>",
  "n": 1,
  "size": "<resolved size>",
  "image": "data:image/...;base64,..."
}
```

`image` 只在编辑或参考图时出现。这是主计划所述 Tier A 单端点扩展协议的直接事实证据。

没有发送或处理 `quality`、`format`、`compression`、`background`、`moderation`、`partial_images`、mask、多个 `images`、file/image ID、Responses `action` 或 `previous_response_id`。

### 图片输入、编辑与参考图

- `imageDataUrl()` 读取整个本地文件，根据扩展名在 JPEG/WebP/PNG 中猜 MIME；其他任何扩展名也会被标为 PNG（`generate.mjs:238-244`）。没有魔数、真实 MIME、尺寸、像素、文件大小或路径范围校验。
- 直接编辑的每个 `--image` 都是独立请求；多张输入代表“同一编辑应用到多个目标图”，不是“一张目标图 + 多张支持图”（`generate.mjs:350-428`）。
- 参考图只接受单个 `--reference-image`，把 `style/composition/subject` 包装为英文提示词，再发送同一个 `image` 字段（`generate.mjs:39-52,431-499`）。
- 不支持遮罩；不验证“遮罩必须对应第一张目标图”的不变量；没有真正的标准 Images Edits multipart。

### 尺寸与质量

旧脚本把 `1K/2K/4K` 当作分辨率档位，而不是 OpenAI 的 `low/medium/high/auto` 质量（`generate.mjs:26-37,152-189`）。提示词中的 `9:16`、`16:9` 等只映射到 `portrait/landscape`，实际像素比例不一定一致：例如 1K 横图为 `1536x1024`（3:2），不是 16:9；2K 竖图为 `1536x2048`（3:4），不是 9:16。2K/4K 自定义尺寸也不能假定所有 OpenAI 兼容中转接受。

因此 1.0 必须把“用户比例意图”“规范化尺寸”“provider 实际支持尺寸”和“质量参数”分开记录。

### 变体、批量与并发

- 单提示词 `--count N` 会被展开为 N 个独立请求，每个请求都发送 `n:1`，且结果 `mode` 被标为 `batch`（`generate.mjs:297-347`）。本地假中转实测 `count=2` 收到两次 POST，而不是一次 `n:2`。这会改变计费、重试和部分成功语义，与主计划“同提示词变体使用 `count/n`，不同资产才进入 batch”冲突。
- 单图编辑和单参考图的 `count=N` 则在一次请求中发送 `n:N`（`generate.mjs:364,372-383,449-460`），同一参数在不同模式下语义不一致。
- 并发被夹在 1～10，但独立任务数量没有脚本级上限（`generate.mjs:181-189,297-321,695-704`）。
- 批量允许不同任务部分成功，汇总成功路径和每项错误；只要任一任务失败，进程退出非零（`generate.mjs:322-347`）。这部分“逐项结果”思路可复用，但 1.0 应返回结构化 partial 状态，而不是让 MCP transport 把整个调用误判为无结果失败。

### 超时与重试

- 1K/2K/4K 基础超时为 180/360/600 秒，图片输入额外增加 120 秒（`generate.mjs:54-58,246-250`）。
- AbortSignal 只保护首次 POST 等待响应头的阶段。收到响应头后立即 `clearTimeout()`，之后读取错误正文、JSON 正文、Base64 解码、图片 URL 下载和写盘均无截止时间（`generate.mjs:264-286`）。
- models 请求和图片 URL 下载也没有超时（`generate.mjs:215-225,501-511`）。
- 没有任何重试、退避、`Retry-After`、幂等键或“预生成/已生成”阶段判断。本地假中转对合成 500 只收到一次请求，确认不存在静默重试。

### 输出解析与文件保存

- 同步 JSON 只识别 `data[].b64_json` 和 `data[].url`（`generate.mjs:215-226,277-285`）。
- 不识别其他 Base64 字段、顶层图片字段、data URL 专用形状、SSE、Responses 事件或中间图。
- 返回 URL 时始终把 provider API Key 作为 Bearer 发给该 URL（`generate.mjs:215-224`）。本地假中转已确认，即使 URL 是另一个资源路径，下载请求仍携带 Authorization。
- 输出无论实际内容类型都以 `.png` 保存（`generate.mjs:229-235`），没有响应 Content-Type/文件魔数校验、最大下载大小或磁盘配额。
- 文件名是秒级时间戳加四位随机字符串，没有排他创建或碰撞检查；理论上可能覆盖同名文件，不满足 1.0 的版本化不覆盖契约。
- 当一个响应含多个结果时，前面的图片可能已写盘；若后续图片下载/写入失败，整个调用进入失败分支，已落盘文件不会进入结果清单，形成孤儿文件（`generate.mjs:277-294`）。

### Windows 进程退出异常

旧脚本在结果打印后直接调用 `process.exit()`（`generate.mjs:341-347,422-428,491-498`）。在当前 Windows、Node v24.15.0 环境中，隔离假中转出现稳定差异：

- 单次 POST、同步 Base64 结果：6/6 返回进程状态 0。
- 普通生成 `count=2`，即脚本内部并发两次 POST：12/12 已打印有效成功 `ROUTEGO_RESULT_JSON`，随后以 Windows 异常终止码 `0xC0000409` 退出。
- URL 结果需要一次 POST 再执行一次图片下载：12/12 同样先打印有效成功结果，再以 `0xC0000409` 退出。

现象与“一个子进程内完成两个 fetch 后立即强制退出”稳定相关，但本次审计没有对 Node/Undici 原生栈做进一步调试，不能把底层根因完全归于某一行。对调用方而言，实际后果已经明确：只看退出码会把已生成成功的任务判成失败，再次执行可能产生重复费用。1.0 不应继承 CLI `process.exit()` 结果协议，应由长期运行的服务返回结构化结果并正常释放资源。

## LA-05 `setup.mjs` 与本地配置

### 实际配置位置和写入

配置保存在旧路径 `~/.codex/routego-image-config.json`，图片默认保存在 `~/Pictures/routego-image`（`generate.mjs:7-8`）。`saveConfig()` 直接同步覆盖 JSON 文件，没有锁、临时文件、原子替换、备份、POSIX `0600` 或 Windows 当前用户 ACL（`generate.mjs:60-75`）。

`loadConfig()` 会吞掉所有读取/JSON 解析错误并返回空对象（`generate.mjs:60-67`）。随后执行任何设置都可能把损坏但仍有价值的原配置覆盖成新文件，用户只能看到“未配置”，没有“配置损坏”状态。

### API Key

正面行为：

- setup 使用 raw TTY 隐藏输入，再通过 stdin 传给子进程（`setup.mjs:101-145,163-172`）。
- 配置展示只返回预览，不显示完整 Key（`generate.mjs:78-82,537-554`）。

风险：

- `generate.mjs` 仍公开并在 help 中列出 `--set-key <key>`（`generate.mjs:576-625,666-680`），会让密钥进入进程参数、终端历史或进程观察工具。1.0 必须删除这条公开路径。
- Key 明文写入普通 JSON，未显式收紧文件权限。
- hidden-input 只处理回车、Ctrl+C 和退格；没有终端 `error/end`、进程信号和异常兜底，异常退出可能未恢复 raw mode（`setup.mjs:106-145`）。

### Endpoint 与模型设置

- setup 会显示并回显完整 endpoint（`setup.mjs:152-161`）；若 URL 含用户名、密码或查询 token，会被写入终端输出和 `--get-config` 结果。
- “刷新模型”是用户显式操作，但内部仍自动猜测 `/models`；界面没有说明该 URL 是推导值，也没有允许用户单独配置 models URL（`setup.mjs:174-187`）。
- 菜单显示默认并发数，但默认设置界面只能修改质量、比例、张数，不能修改并发（`setup.mjs:70-80,217-232`）。

## LA-06 编码审计

对 manifest、Skill、两个 `.mjs` 文件进行了严格 UTF-8 解码检查：四个文本文件都是有效 UTF-8、无 BOM、无 `U+FFFD` 替换字符；`plugin.json` 的中文主要使用 JSON `\uXXXX` 转义。这一快照中 **没有发现已落盘的乱码字节**。

仍需迁移处理的编码风险：

- 当前没有中文提示词、中文路径、emoji、不同控制台编码或跨平台 stdio 的自动测试。
- Skill 使用硬编码 shell 命令，Shell 参数引用仍是提示词和路径传递的唯一边界；1.0 应避免由 Agent 拼接命令行。
- setup 明确用 UTF-8 解析子进程输出（`setup.mjs:27-39`），这部分意图可保留；新版本应统一 JSON/stdio/文件为 UTF-8，并在 Windows、macOS、Linux 测试中文用户目录和文件名。
- 输入文件 MIME 与输出扩展名错误不是字符编码问题，但属于“内容编码声明错误”，必须通过魔数和 Content-Type 修复。

## LA-07 兼容矩阵

| 能力 | 旧插件实际行为 | 1.0 目标 | 迁移决定 |
|---|---|---|---|
| 插件发现 | Manifest 只注册 Skill | Skill + 本地 MCP/HTTP + Studio | Manifest 重建；保留插件名与品牌资源 |
| 安装路径 | Skill 硬编码 `~/plugins/routego-image` | 自包含、可重定位插件包 | 必须淘汰硬编码路径 |
| 配置路径 | `~/.codex/routego-image-config.json` | `~/.codex/routego-image/config.json` | 不迁移、不删除旧文件；新旧并存 |
| Key 展示 | 仅预览 | 全链路脱敏 | 保留预览概念，缩短并统一脱敏规则 |
| Key 写入 | stdin 和不安全 CLI 参数均可 | 受限权限、原子写入，禁止聊天/参数泄露 | 只保留安全输入；删除公开 `--set-key` |
| API Base | 自动补 `/v1/images/generations` | 精确端点优先；兼容规则显式启用 | 保留为命名的 legacy 规范化模式，禁止无条件应用 |
| Models | 自动派生 `/models` | models URL 可空、不可默认猜测 | 默认不请求；显式配置/确认后启用 |
| 文生图 | JSON `{model,prompt,n,size}` | Tier A/B/C 适配 | 作为 Tier A fixture 保留 |
| 图片输入 | 同端点单个 `image` data URL | Tier A 可选 `image/images`，显式能力验证 | 保留单图兼容形状；默认 `unknown` |
| 标准 Edits | 不支持 | Tier B multipart | 全新实现，确认 URL 后启用 |
| Responses | 不支持 | Tier C、多轮、SSE | 全新实现，确认能力后启用 |
| 多参考图 | 不支持，最多一张 | 最多 16 张，带 role/label | 全新内部契约；legacy adapter 降级为最多一张 |
| 直接编辑 | 同 generations + `image` | 目标图、支持图、遮罩语义明确 | 旧路径只能标为 Tier A/degraded，不得叫标准 Edits |
| 遮罩/外绘 | 不支持 | mask 对应第一目标图，支持外绘 | 全新实现和本地校验 |
| 同提示词变体 | N 个独立 `n:1` 请求 | 一个任务的 `count/n` | 必须修正；不兼容旧计费语义 |
| 独立批量 | 无任务上限，并发 1～10 | 最多 20，并发 1～10，逐项结果 | 可重用 worker 思路，增加 Schema 和上限 |
| 尺寸/质量 | 1K/2K/4K 自定义矩阵 | 尺寸、质量、provider 能力分离 | 作为 legacy capability 映射，不做公共真值 |
| 输出格式 | 一律写 `.png` | PNG/JPEG/WebP + 压缩率 | 重写解析和命名 |
| 透明背景 | 不支持 | 色键去背 + 能力确认 | 全新实现 |
| moderation | 不支持 | `auto/low` + 结构化 blocked | 全新实现 |
| 同步 Base64 | 支持 `data[].b64_json` | 支持 | 保留 fixture，重写校验和限额 |
| 图片 URL | 支持但泄露 Bearer 给任意 URL | 安全下载、默认不转发凭证 | 旧逻辑必须删除后重写 |
| SSE/中间图 | 不支持 | Studio 可见，MCP 默认仅最终图 | 全新实现 |
| 超时 | 只覆盖 POST 到响应头 | 分阶段截止时间 | 重写 |
| 重试 | 无 | 仅预生成 429/5xx，最多两次退避 | 全新实现；禁止跨适配器重放 |
| 部分成功 | 批量逐项；单响应内可能产生孤儿文件 | 所有层级结构化 partial | 保留逐项思想，重写文件事务 |
| 结果交接 | stdout 标记行 + 绝对路径纪律 | MCP 结构化结果 + 图片内容 | 保留“当前请求唯一来源”原则，淘汰文本标记协议 |
| 图库/Studio | 无 | 完整本地 Studio 和图库 | 全新实现 |

## LA-08 风险清单

| ID | 等级 | 风险与事实证据 | 1.0 处理要求 |
|---|---|---|---|
| `R-01` | 严重 | 图片响应中的任意 URL 都会收到 provider Bearer；本地假中转已复现（`generate.mjs:215-224`） | 默认不向资源 URL 转发认证；重定向逐跳复核；限制协议、地址、大小、类型和超时 |
| `R-02` | 高 | 用户精确端点和 `/models` 被自动派生，可能请求错误路径并把 Key 发到未经确认的接口（`generate.mjs:114-130,501-506`） | 区分 exact endpoint 与 legacy API Base；models URL 默认空 |
| `R-03` | 高 | Key 可通过 CLI 参数设置，配置无 ACL/0600、锁或原子写入（`generate.mjs:60-75,614-625,666-680`） | 禁止参数密钥；受限权限、文件锁、临时文件和原子替换 |
| `R-04` | 高 | 任意本地文件都能被读入并伪装为 `data:image/png` 发给中转（`generate.mjs:238-244`） | 路径授权、大小上限、扩展名 + 魔数 + 解码校验，拒绝非图片 |
| `R-05` | 高 | 超时在响应头后失效，正文和下载无上限，可能无限等待或耗尽内存/磁盘（`generate.mjs:215-235,246-294`） | 分阶段 deadline、流式限额、下载配额、取消传播 |
| `R-06` | 高 | `count=N` 在普通生成中变成 N 次请求，改变计费和重试语义；实测 count=2 为两次 `n:1`（`generate.mjs:297-347`） | 公共契约明确 variants 与 batch；降级 fan-out 必须显式记录请求数 |
| `R-07` | 高 | Manifest/Skill 无条件称为编辑，但没有能力状态或标准 Edits；失败后才猜“不支持”（`plugin.json:12`; `SKILL.md:256-258`） | 图片输入默认 `unknown`；未经验证禁用编辑提交 |
| `R-08` | 中 | 多结果保存中途失败会留下未报告文件，重试可能重复收费/重复落盘（`generate.mjs:277-294`） | 每个输出独立状态；临时文件、提交/清理策略和 request/attempt ID |
| `R-09` | 中 | URL/Base64 内容无类型校验且一律 `.png`（`generate.mjs:215-235`） | 以 Content-Type + 魔数确定格式，校验后再原子落盘 |
| `R-10` | 中 | 生成错误正文可能完整进入异常、stdout 和结果 JSON；endpoint 也完整回显（`generate.mjs:266-274`; `setup.mjs:152-161`） | 结构化错误、长度限制、凭证/URL 查询参数脱敏、普通日志禁止正文 |
| `R-11` | 中 | count/defaults 对 `NaN` 等输入缺少严格校验；batch 无 20 项上限；未知 CLI 参数被忽略（`generate.mjs:181-189,557-610,695-704`） | 所有入口共享 Zod 运行时校验，拒绝未知字段和越界值 |
| `R-12` | 中 | 配置损坏被吞掉，下一次设置可能覆盖原文件（`generate.mjs:60-75`） | 显式 `config_corrupt`、备份、恢复指引，禁止静默覆盖 |
| `R-13` | 低 | hidden-input 异常路径可能不恢复 raw mode（`setup.mjs:101-145`） | 使用成熟输入组件或完整 signal/finally 清理 |
| `R-14` | 低 | 当前快照 UTF-8 正常，但没有中文/emoji/路径跨平台回归 | Foundation 加入 UTF-8 与中文路径 contract fixtures |
| `R-15` | 高 | Windows/Node v24 下，多 fetch 命令先输出成功结果再以 `0xC0000409` 异常退出；count=2 和 URL 下载各 12/12 复现（`generate.mjs:297-347`） | 淘汰短命 CLI + `process.exit()` 协议；服务层正常返回并释放资源；防止按退出码自动重放收费请求 |

## LA-09 Foundation 必须冻结的契约建议

### `FZ-01` Endpoint 配置与规范化

- 配置同时保存用户原始值和已验证的规范化值，但日志/API 只返回脱敏值。
- 明确两种输入语义：`exact-generation-endpoint` 与 `legacy-api-base`。只有后者允许兼容追加 `/v1/images/generations`。
- `modelsUrl`、`editsUrl`、`responsesUrl` 均为独立可空字段；不得从唯一端点默认派生。
- 仅允许 HTTP(S)；远程 HTTP 默认拒绝，回环 HTTP 可用；禁止 URL userinfo，并脱敏 query/fragment。

### `FZ-02` 能力键、状态与证据

- 能力必须按 `provider + model + endpoint/transport` 独立记录。
- 状态固定为 `unknown | supported | unsupported | degraded`，同时保存 `verifiedAt`、`source`、脱敏请求/响应形状和降级说明。
- 鉴权、429、超时、5xx、moderation 和单次模型失败不得写成 `unsupported`。
- `singleImageInput` 与 `multiImageInput/maxImages` 必须分开；旧插件只提供“单个 `image` data URL”的证据。

### `FZ-03` 内部请求与 Tier A 映射

- 内部请求使用主计划统一字段，不直接暴露旧 CLI 参数。
- Tier A 文生图 wire fixture 固定为 JSON `{model,prompt,n,size}`。
- Tier A 图片输入 fixture 固定为在同一 JSON 中增加单个 `image: data URL`；`images[]` 只能在单独验证后启用。
- 旧 `style/composition/subject` 可映射为 `references[].role`，但 adapter 必须声明 `maxImages=1` 时的结构化降级/拒绝。

### `FZ-04` 变体、批量与计费语义

- `count` 表示同一任务的多个变体；`batch.tasks[]` 表示独立资产任务。
- provider 支持 `n` 时优先单请求；不支持而需要 fan-out 时，结果标记 `degraded`、`attemptCount`、`providerRequestCount`，不得伪装为原生 `n`。
- batch 最多 20 项，并发 1～10；每项拥有独立状态、错误、输出和输入输出关系。

### `FZ-05` 超时、重试和取消

- 分别定义连接/响应头、响应正文、资源下载、总任务截止时间；AbortSignal 贯穿解析和写盘前阶段。
- 仅对明确“尚未生成输出”的 429/5xx 最多退避两次；解析失败、超时、部分结果或已返回图片后不自动重试。
- 禁止因超时/限流切换 adapter 或降低质量；所有重试记录 attempt 和原因。

### `FZ-06` 响应解析与安全下载

- 统一解析 Base64、图片 URL、同步 JSON、SSE 和 Responses 事件，区分中间图与最终图。
- 资源 URL 默认 **不携带 provider Authorization**；只有同源且 provider 配置显式要求时才可使用受控认证策略。
- URL 每次重定向都重新校验协议、目标地址和认证策略；设置最大字节数、Content-Type、图片魔数、解码尺寸和下载超时。
- Parser 返回逐输出状态，不能因第 N 张失败而丢失前 N-1 张事实。

### `FZ-07` 文件结果与事务

- 先写同目录临时文件，完成类型/哈希/尺寸校验后原子改名。
- 文件扩展名与实际格式一致；默认版本化、排他创建，绝不覆盖同名资产。
- 结果固定包含 request ID、actual parameters、transport、provider request count、全部文件绝对路径、输入输出关系、partial 信息和可展示图片内容。
- 失败后明确清理临时文件；已成功文件要么纳入 partial 结果，要么由受控事务回滚，不能成为孤儿。

### `FZ-08` 本地图片输入

- 只接受允许的普通文件；规范化绝对路径并检查扩展名、魔数、解码、大小和像素上限。
- target、supporting references 和 mask 使用不同字段；mask 永远对应第一目标图。
- mask 在发送前验证/转换为同尺寸、同格式、小于 50MB 且含 alpha；无效请求不得发往中转。

### `FZ-09` 配置与凭证

- 新配置只写 `~/.codex/routego-image/config.json`；旧 `routego-image-config.json` 不导入、不删除。
- Windows 显式限制为当前用户 ACL，POSIX 使用 `0600`；文件锁 + 临时文件 + 原子替换 + 损坏备份。
- API Key 不允许出现在 CLI 参数、错误、普通日志、任务元数据、MCP 返回或 HTTP 响应；只允许安全输入通道和统一短预览。

### `FZ-10` 错误与日志

- 冻结错误分类：`config_missing`、`config_corrupt`、`capability_unavailable`、`auth_failed`、`rate_limited`、`timeout`、`provider_5xx`、`moderation_blocked`、`invalid_input`、`invalid_response`、`download_failed`、`file_write_failed` 等。
- 错误包含阶段、HTTP 状态、可重试性和面向用户的简短信息；原始正文只允许限长、脱敏后进入调试诊断。
- 任何日志禁止完整认证头、完整 Key、用户图片数据 URL/Base64 和未脱敏 endpoint query。

### `FZ-11` 插件定位与交付

- Skill 和 manifest 只能使用相对插件根目录或运行时提供的资源路径，不得假定个人 `~/plugins` 目录。
- 1.0 发布包必须自包含 Node 20.19+ 可运行产物；旧 stdout 标记协议不作为公共 API。

### `FZ-12` 编码

- JSON、stdio、配置、索引和文本资源统一 UTF-8。
- 契约测试必须包含中文提示词、emoji、中文用户名/目录、带空格路径和 Windows/macOS/Linux 换行。

## LA-10 验证方式、阻塞与残余风险

### 已执行检查

- 按哈希快照逐行阅读 manifest、Skill、`generate.mjs`、`setup.mjs`。
- `plugin.json` 已通过 JSON 解析。
- 两个 `.mjs` 已通过 `node --check`。
- 四个文本文件已通过严格 UTF-8 解码，无替换字符。
- 使用隔离 `USERPROFILE/HOME` 运行 `--get-config` 和 `--help`，确认不会读取真实配置，默认值为 2K/portrait/1/并发 3，并确认 help 仍暴露 `--set-key <key>`。
- 使用仅监听 `127.0.0.1` 的临时假中转、虚构凭证和 1×1 测试 PNG 验证：
  - models 请求实际为 `GET /v1/models` 且携带 Bearer；
  - 文生图为 `POST /v1/images/generations` JSON；
  - 普通 `count=2` 为两次 `n:1`；参考图/编辑 `count=2` 为一次 `n:2`；
  - 编辑/参考图都发送单个 `image` data URL；
  - 一个成功、一个 500 的 batch 返回一条成功路径和一条失败，失败任务只请求一次；
  - 响应图片 URL 的下载请求携带 Authorization；
  - 自定义精确路径被追加 `/v1/images/generations`。
- 另做进程退出重复测试：单 POST Base64 结果 6/6 返回状态 0；普通 `count=2` 和 URL 下载两类多 fetch 场景各 12/12 在打印有效成功结果后以 `0xC0000409` 异常退出。该失败已记录为 `R-15`，未被当作通过项隐藏。
- 所有假中转测试只使用临时目录，结束后已清理；没有公网请求和真实生成费用。

### 阻塞项

无。该审计是 Foundation proposal 之前的证据输入，当前不绑定 OpenSpec change/task；由 Program Controller 后续映射到 Foundation specs/tasks。

### 残余风险

- 按任务边界未对真实中转发起请求，所以尚未证明真实 provider 对 `image`、`n`、非标准尺寸、Base64/URL 或错误形状的具体兼容性。
- 本审计对象是指定源码目录快照，没有比较 marketplace 缓存副本或历史版本；若安装缓存与源码不一致，Integration 需重新做包内容哈希核对。
- 动态检查在 Windows、Node v24.15.0 上完成；目标最低 Node 20.19 以及 macOS/Linux 行为仍需后续 CI 验证。
- 未构造超大响应、慢正文、重定向链、损坏配置、磁盘满、文件碰撞和不同图片编码；这些应进入 Foundation mock contract 和 Creation/Library 测试。

### 推荐交接

Foundation 优先把 `FZ-01`～`FZ-12` 写入共享 Schema、安全规则和 mock relay fixtures；其中 `R-01` 必须在任何真实 URL 图片响应验收前修复。Creation 后续以 `single-endpoint-json` 适配器承接旧兼容行为，不直接复制旧脚本。
