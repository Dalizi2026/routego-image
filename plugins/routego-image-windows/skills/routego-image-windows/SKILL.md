---
name: routego-image-windows
description: Use Routego Image for Windows for safe local image generation, editing, Library operations, and Studio work. 使用 Routego Image Windows 安全完成本地生图、编辑、图库管理和 Studio 工作。
---

# Routego Image for Windows

Use the same eight Routego Image tools as the macOS edition. The Windows edition stores its configuration, credentials, runtime state, diagnostics, and Library separately under the current Windows user profile.

- Before a billable generation or edit, inspect the current Routego status.
- Never request or print an API key, authorization header, raw provider response, or local user path in chat.
- When a request may have been billed but produces no image, do not retry automatically. Report the safe diagnostic returned by Routego and direct the user to Studio only when configuration is needed.
- Open Studio for provider configuration; do not ask the user to paste secrets into chat.
- When Codex opens Studio, use only the current call's fresh URL. The Windows Studio remains available after Codex closes the original MCP channel; a user can reopen it through the tool if the browser page itself has expired.

The Windows edition uses the same image workflow and public tool contract as Routego Image, but it does not read or overwrite the macOS edition's settings or Library.
