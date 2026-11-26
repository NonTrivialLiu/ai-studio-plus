# Privacy Policy — AI Studio Plus

**Last Updated**: 2026-11-26  
**Applies to**: AI Studio Plus browser extension (`v1.0.1+`) for Microsoft Edge and Chromium-based browsers

## Overview

**AI Studio Plus** is built strictly on a **privacy-by-design, zero-telemetry** architecture:

- **Zero Personal Data Collection**: AI Studio Plus does **not** collect, store externally, sell, or transmit your Google account info, prompt contents, chat attachments, cookies, IP address, or browsing analytics.
- **Zero Special Permissions**: As declared in [`extension/manifest.json`](extension/manifest.json), the extension requests **no** `chrome.*` permissions (`storage`, `tabs`, `cookies`, `history`, etc.) and declares **no** persistent background service worker.
- **Zero Remote Code**: All JavaScript and CSS run locally from the extension package itself. No external scripts are loaded or evaluated (`eval` / `innerHTML` are statically forbidden).
- **Strict Host Scope**: Content scripts activate exclusively on `https://aistudio.google.com/*` and `https://aistudio.google.cn/*`.
- **Same-Origin Session Reuse**: Sidebar listing, search, inline rename, copy, and delete actions work by calling Google AI Studio's own APIs directly through your existing signed-in browser session—never through any developer-operated or third-party server.
- **Tab-Scoped Ephemeral Metadata Cache**: Minimal conversation metadata (`id`, `title`, and `updatedAt` timestamp) is cached strictly in the current tab's `sessionStorage` to enable instant search and sidebar rendering, and is cleared automatically by the browser when the tab closes.

## Contact & Support

If you have any questions regarding privacy or security, please open an issue on GitHub:  
https://github.com/NonTrivialLiu/ai-studio-plus/issues

---

# 隐私政策 — AI Studio Plus

**最后更新**：2026-11-26  
**适用范围**：AI Studio Plus 浏览器扩展（`v1.0.1+`）

## 核心原则

**AI Studio Plus** 严格采用 **零权限、零后台、零遥测** 架构：

- **零个人数据收集**：不收集、不外传、不出售任何 Google 账户信息、对话正文、附件、Cookie、IP 地址或使用统计。
- **零额外权限与零后台服务**：[`extension/manifest.json`](extension/manifest.json) 未申请任何 `chrome.*` 敏感权限，也无常驻 Service Worker。
- **零远程代码执行**：全部 JS/CSS 均内置于扩展包内本地执行，不加载远程脚本，严禁 `eval` 与 `innerHTML`。
- **严格域名边界**：仅在 `https://aistudio.google.com/*` 与 `https://aistudio.google.cn/*` 运行。
- **同源会话直连**：侧栏列表、搜索、重命名、复制与删除操作完全复用你当前浏览器的已有登录态直接与 Google AI Studio 通信，不经过任何第三方或开发者服务器。
- **标签页级临时元数据缓存**：仅在当前标签页的 `sessionStorage` 中临时缓存会话 ID、标题与更新时间用于即时展示与搜索，关闭标签页即由浏览器自动销毁。

## 联系方式

如有任何隐私或安全疑问，欢迎通过 GitHub Issues 联系：  
https://github.com/NonTrivialLiu/ai-studio-plus/issues
