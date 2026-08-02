---
name: routego-image-windows
description: Use Routego Image for Windows for safe local image generation, editing, Library operations, and current-session Studio work. 使用 Routego Image Windows 安全完成本地生图、编辑、图库管理和当前会话 Studio 操作。
---

# Routego Image for Windows

Use the Routego Image for Windows tools for local image generation, editing, Library operations, and Studio workflows.

- Before a billable generation or edit, inspect the current Windows Routego status.
- Never request or print an API key, authorization header, raw provider response, or local user path in chat.
- When a request may have been billed but produces no image, do not retry automatically. Use the returned safe diagnostics to distinguish a provider failure from a Windows network or proxy response.
- Open Studio for provider configuration; do not ask the user to paste secrets into chat.

The Windows edition keeps its configuration, temporary runtime state, and diagnostics separate from the Mac edition. Its image workflow and public tools match Routego Image.
