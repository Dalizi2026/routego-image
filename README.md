# Routego Image v1.0.5

<p>
  <img src="plugins/routego-image/assets/logo.png" width="112" alt="Routego Image v1.0.5 标志">
</p>

Routego Image 是运行在 Codex 桌面端中的本地图片工作流插件。它把图片生成、图片编辑、批量任务、图库管理与 Studio 工作台放进同一个对话与本机环境中。

> 本仓库是可直接安装的 Codex 插件市场源。插件显示名为 `Routego Image v1.0.5`。

## 你可以做什么

- 在 Codex 对话中生成或编辑图片。
- 用 Studio 工作台配置服务商、模型与默认出图参数。
- 保存并搜索图库中的图片，按文件夹整理、恢复或导入导出 ZIP。
- 一次提交多项独立图片任务，并查看每项实际结果。
- 从图库读取已有图片的生成配方，作为下一次创作的起点。

## 安装

在 Codex 桌面端新开一个对话，直接发送下面这段话即可：

```text
请从 GitHub 仓库 Dalizi2026/routego-image 安装 Routego Image v1.0.5 插件。先添加该仓库为插件市场源，再安装 routego-image；完成后告诉我安装结果和版本号。
```

安装完成后，重新开启一个 Codex 对话即可使用插件。

<details>
<summary>终端安装方式</summary>

```bash
codex plugin marketplace add Dalizi2026/routego-image --ref main
codex plugin add routego-image@routego-image
```

</details>

## 第一次使用

### 1. 打开 Studio

在 Codex 对话里发送：

```text
请打开 Routego Image Studio。
```

Codex 会打开本机 Studio。首次使用会自动进入“设置”，并显示页内的新手引导。

不要保存、转发或手动修改旧的 Studio 地址。每次需要打开 Studio 时，都让 Codex 重新打开一次，以获得当前会话的安全链接。

### 2. 连接你的图片服务商

跟随高亮引导，在“供应商管理”中完成：

1. 填写一个便于识别的供应商名称。
2. 填写服务商提供的 API 地址或完整生图端点。
3. 仅在 Studio 的 API Key 输入框中填写密钥。
4. 点击“获取模型”，选择默认模型；若服务商未返回模型，可手动填写模型名称。
5. 点击“保存”。保存后，该供应商会自动成为当前供应商。

API Key 只保存在本机，Studio 不会再次显示完整内容。不要把密钥发送到 Codex 对话、截图、Issue 或任何公开位置。

### 3. 保存默认出图参数

引导会继续定位到生成工作台。按需要设置图片比例、清晰度和输出选项，然后保存。以后在 Codex 对话里生成图片时，会默认使用这些设置。

### 4. 开始生成

回到 Codex 对话，直接描述你想要的画面，例如：

```text
请使用 Routego Image 生成一张雨后上海街头的电影感夜景，霓虹灯倒映在湿润路面上。
```

没有配置服务商时，你也可以直接提出生成请求。Codex 会先为当前会话打开 Studio，让你完成配置后再继续。

## 常用对话指令

| 目的 | 直接发给 Codex 的话 |
| --- | --- |
| 打开工作台 | `请打开 Routego Image Studio。` |
| 配置或更换服务商 | `请打开 Routego Image Studio，我要配置图片服务商。` |
| 生成图片 | `请使用 Routego Image 生成一张……` |
| 编辑图片 | `请用 Routego Image 编辑这张图片，保持……不变，并把……改成……` |
| 批量生成 | `请用 Routego Image 批量生成以下图片任务：……` |
| 查找图库图片 | `请在 Routego Image 图库中查找……` |
| 重新查看引导 | 打开 Studio，在“设置”中点击“重新查看新手引导”。 |

## Studio 导览

- **工作台**：调整默认出图参数，提交生成与编辑任务。
- **图库**：浏览已保存的图片与来源关系，按文件夹整理，导入或导出 ZIP。
- **设置**：管理服务商、端点、API Key、模型与当前默认项。

Studio 支持深色和浅色模式，也会在窄屏下调整新手引导位置与内容宽度。

## 费用与隐私

- Routego Image 在本机启动运行时与 Studio；图片生成或编辑请求会发送给你在 Studio 中配置的服务商。
- 费用、速率限制、内容政策与可用能力由该服务商和所选模型决定。
- 模型刷新不会生成图片。涉及真实生成、编辑或批量任务前，请确认自己的服务商账户、额度与计费规则。
- 生成结果可保存到本机图库；删除或导出操作会在执行前要求明确确认。

## 遇到问题

### Studio 打不开或页面已失效

回到 Codex 对话重新发送：

```text
请重新打开 Routego Image Studio。
```

不要复用以前的 Studio 链接。

### 插件已安装，但无法生成

在 Codex 对话中发送：

```text
请检查 Routego Image 的配置、服务状态和当前模型。
```

如果显示未配置，请打开 Studio，确认当前供应商已保存 API Key、端点与默认模型。

### 我想升级插件

把下面这段话直接发送给 Codex 桌面端：

```text
请更新 GitHub 市场源 Dalizi2026/routego-image，并升级 Routego Image v1.0.5 到最新版本；完成后告诉我版本号和更新结果。
```

## 反馈

请在本仓库的 [Issues](https://github.com/Dalizi2026/routego-image/issues) 提交问题或建议。提交前请移除 API Key、访问令牌、完整 Studio 地址和私人图片。

## 第三方说明

插件内使用的第三方组件与资源说明位于 [`THIRD_PARTY_NOTICES.md`](plugins/routego-image/THIRD_PARTY_NOTICES.md)。

## v1.0.5 更新说明

### v1.0.5

- 完善透明背景：自动和色键模式生成受控绿幕后进行色键识别与边缘去绿，输出真实 Alpha PNG。
- 原生透明仅在当前渠道已经验证支持时使用；本地回退结果不再被误报为成功交付。
- 增加本地背景分割运行时的资源完整性校验，修复后台任务完成后图库刷新可见性，并强化插件包验证。

### v1.0.4

- 优化 Studio 图库的筛选、排序、分页、下载、详情和响应式界面。
- 增加渠道能力证据展示与真实场景参数验证，改善图库读写与任务保存稳定性。

### v1.0.3

- 统一 Studio 中的图像响应等待上限与插件执行链路，修复长时任务状态处理。

### v1.0.2

- 支持 Codex 对话附件的单图编辑、多参考图生成和编辑不变量约束。
- 增强 OpenAI 兼容中转的图像输入与输出处理。

### v1.0.1

- 建立 Routego Image 1.0 的本地配置、兼容图像调用、默认参数、图库与可验证打包基础。

## Windows 专用版

Windows 请安装独立插件 `routego-image-windows`（v1.0.5）。它与 macOS 版共享相同的公开功能版本号，但使用独立的本地配置与运行目录，不会覆盖 macOS 版的设置或图库。

```text
请从 GitHub 仓库 Dalizi2026/routego-image 安装 Windows 专用 Routego Image 插件：先更新市场源，再安装 routego-image-windows；完成后告诉我版本号。
```

终端方式：

```bash
codex plugin marketplace add Dalizi2026/routego-image --ref main
codex plugin add routego-image-windows@routego-image
```

后续维护以 macOS 稳定版为主：先完成 macOS 发布，再同步共享核心并通过 Windows 专项验收后发布 Windows 版。