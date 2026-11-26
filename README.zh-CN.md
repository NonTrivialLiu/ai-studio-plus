<div align="center">

# AI Studio Plus

**将 Google AI Studio 左侧栏升级为可搜索、可多选、无限滚动的原生会话工作区，并附带用户消息折叠与 GPU / 续航优化。**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/NonTrivialLiu/ai-studio-plus/actions/workflows/build.yml/badge.svg)](https://github.com/NonTrivialLiu/ai-studio-plus/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/NonTrivialLiu/ai-studio-plus?label=Release)](https://github.com/NonTrivialLiu/ai-studio-plus/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](extension/manifest.json)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg)](package.json)

</div>

---

## 为什么选择 AI Studio Plus？

Google AI Studio 原生侧栏默认不展示历史对话列表，查找或整理历史对话需要跳转到单独的 History 页面；长提问气泡占满屏幕，且大量毛玻璃与过渡动画在笔记本上容易拉高 GPU 功耗。

**AI Studio Plus** 以零额外权限、零后台常驻、零第三方服务器的方式，在保留原生设计语言与明暗主题的前提下补齐上述体验。

---

## 核心功能

- **原生融合的无限历史流** — 按本地日历日自动分组（*Today*、*Yesterday*、*Previous 7 days*、*Previous 30 days*、*Earlier*），滚动触底自动加载更早记录，点击即站内切换（不整页刷新）。
- **全量历史即时搜索** — 输入关键词即时过滤已加载对话，并在后台自动拉取尚未加载的早期分页，直到命中或拉取完毕。
- **高效行级操作** — 单击切换、双击或按 `F2` 原位重命名（兼容中文输入法组字）；行尾 `⋮` 与右键菜单支持 **Rename**、**Share**（调用原生 Google Drive 分享面板）、**Make a copy**、**Select** 与 **Delete**。
- **多选与批量移入回收站** — 长按会话行（约 `500ms`）或点击列表顶部的选择图标进入多选；搜索过滤不会丢失已勾选项，确认后逐项安全移入回收站。
- **左右栏悬浮预览** — 原生导航或右侧 *Run settings* 收起时，鼠标悬停切换按钮即可临时覆盖预览（不挤压正文宽度），点击图钉图标可固定展开；支持 `⌘B` / `Ctrl+B` 快捷开关左栏。
- **清爽底部抽屉与扩展共存** — 将 *Explore / Build / Manage* 收纳进可向上展开的底部抽屉，隐藏升级推广卡片，并与 Voyager 等其它扩展和谐共存。
- **深色用户气泡与长消息折叠** — 用户消息右对齐呈现，高度超过 `300px` 时自动折叠为 `240px` 渐隐预览，一键展开或收起，并保留站点的离屏虚拟占位。
- **GPU 与续航优化** — 移除高开销的全局 `backdrop-filter` 毛玻璃（替换为明暗主题匹配的实色面板）并精简非功能性持续动画，同时保留加载指示器。

---

## 安装指南

> 适用于 **Google Chrome**、**Microsoft Edge**、**Brave**、**Arc** 等 Chromium 内核浏览器，生效域名为 `aistudio.google.com` 与 `aistudio.google.cn`。

### 方式一：下载预打包发行版（推荐）

1. 下载最新发行压缩包：[**AI-Studio-Plus-WebExtension.zip**](https://github.com/NonTrivialLiu/ai-studio-plus/releases/latest/download/AI-Studio-Plus-WebExtension.zip)
2. 将压缩包解压到一个**长期保留**的本地文件夹（加载后请勿删除该文件夹）。
3. 在浏览器地址栏打开扩展管理页：
   - Chrome / Arc / Brave：`chrome://extensions`
   - Microsoft Edge：`edge://extensions`
4. 打开右上角的 **开发者模式** 开关。
5. 点击 **加载已解压的扩展程序**，选择解压后包含 `manifest.json` 的目录。
6. 打开或刷新 [Google AI Studio](https://aistudio.google.com/) 即可生效。

### 方式二：从源码构建

需要 **Node.js >= 22**：

```bash
git clone https://github.com/NonTrivialLiu/ai-studio-plus.git
cd ai-studio-plus
npm run build
```

随后在 `chrome://extensions` 中点击 **加载已解压的扩展程序** 并选择项目下的 [`extension/`](extension/) 目录。

### 如何更新

下载新版压缩包覆盖解压到原目录（或执行 `git pull && npm run build`），在 `chrome://extensions` 点击 **AI Studio Plus** 卡片上的 **刷新（↻）** 按钮，然后刷新 AI Studio 页面即可。

---

## 快捷键与交互手势

| 操作 | 快捷键 / 手势 |
|---|---|
| 展开 / 收起左侧导航 | `⌘ + B`（macOS）/ `Ctrl + B`（Windows / Linux） |
| 临时悬浮预览左栏 / Run settings | 鼠标悬停原生开关按钮（`300ms`） |
| 当前标签页打开对话 | 单击会话行 |
| 新标签页 / 窗口打开对话 | `⌘ + 单击` / `Ctrl + 单击` / `Shift + 单击` |
| 原位重命名对话 | 双击会话行或按 `F2` |
| 打开行操作菜单 | 点击行尾 `⋮` 或右键点击会话行 |
| 进入多选模式 | 长按会话行（约 `500ms`）或点击选择图标 |
| 取消 / 关闭菜单、预览或退出多选 | `Esc` |

---

## 隐私与安全承诺

- **零额外权限** — [`manifest.json`](extension/manifest.json) 未申请任何 `chrome.*` 敏感权限。
- **零后台服务** — 无 Service Worker 常驻进程，仅在 `aistudio.google.com` 与 `aistudio.google.cn` 运行。
- **零遥测与外部通信** — 直接复用你在 Google AI Studio 的现有登录态；会话列表仅在当前标签页的 `sessionStorage` 中临时缓存 ID、标题和更新时间。
- **Strict Trusted Types 合规** — 全部界面严格使用原生 DOM API（`createElement` / `textContent`）构建，无 `innerHTML` 与动态 `eval`。

---

## 常见问题

<details>
<summary><strong>是否适配浅色与深色主题？</strong></summary>
<p>支持。扩展的侧栏、浮层、边框、悬停态与删除危险色均复用 AI Studio 的主题变量，并配有对应的 <code>light-dark()</code> 深浅色兜底。</p>
</details>

<details>
<summary><strong>是否支持 Firefox？</strong></summary>
<p>Firefox 128+ 已支持所需的 Manifest V3 <code>MAIN</code> 世界脚本，但目前尚未进行完整的 Firefox 实测与商店签名适配，当前主要维护与测试 Chromium 系列浏览器。</p>
</details>

<details>
<summary><strong>如果 Google AI Studio 改版导致侧栏不显示怎么办？</strong></summary>
<p>本扩展依赖站点的内部 DOM 结构与会话接口。如遇站点更新导致异常，可先到 <a href="https://github.com/NonTrivialLiu/ai-studio-plus/releases">Releases</a> 查看是否有新版更新，或直接提交 <a href="https://github.com/NonTrivialLiu/ai-studio-plus/issues/new/choose">Bug Report</a>。</p>
</details>

---

## 参与贡献与开源协议

欢迎提交 Issue、交互建议与 Pull Request！

- 开发者环境搭建、代码规范与提交流程请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 核心架构与模块边界说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

本项目基于 [MIT License](LICENSE) 开源。
