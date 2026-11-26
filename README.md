<div align="center">

# AI Studio Plus

**Turn Google AI Studio's left sidebar into an instant, searchable, multi-selectable chat workspace — with smart user bubble folding and GPU/battery optimizations.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/NonTrivialLiu/ai-studio-plus/actions/workflows/build.yml/badge.svg)](https://github.com/NonTrivialLiu/ai-studio-plus/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/NonTrivialLiu/ai-studio-plus?label=Release)](https://github.com/NonTrivialLiu/ai-studio-plus/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green.svg)](extension/manifest.json)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg)](package.json)

</div>

---

## Why AI Studio Plus?

Google AI Studio's default navigation hides your recent prompts behind a separate History page, lacks quick sidebar management, renders long user prompts uncollapsed, and uses heavy CSS `backdrop-filter` / transition animations that drain battery on laptops.

**AI Studio Plus** blends seamlessly into AI Studio's native design system (Light & Dark themes) without extra permissions, background workers, or third-party servers.

---

## Features

- **Native Infinite History Sidebar** — Groups chats automatically by calendar day (*Today*, *Yesterday*, *Previous 7 days*, *Previous 30 days*, *Earlier*), loads older pages on scroll, and switches chats without full page reloads.
- **Instant Search Across All History** — Filters loaded chats as you type and automatically fetches older pages in the background until matches are found.
- **Fast Row Actions** — Click to open, double-click or press `F2` to rename inline (IME-safe), or use the three-dot / right-click menu for **Rename**, **Share** (via native Google Drive dialog), **Make a copy**, **Select**, and **Delete**.
- **Multi-Select & Batch Trash** — Long-press any chat (~500 ms) or click the list selection icon to check multiple chats and move them to Trash in one flow, preserving selections even while searching.
- **Hover-to-Peek Sidebars** — Hover the collapsed left navigation toggle or right *Run settings* toggle to preview without shifting your prompt layout; click the pin icon to lock open, or press `⌘B` / `Ctrl+B` to toggle the left sidebar.
- **Compact Bottom Drawer & Clean Nav** — Tucks *Explore / Build / Manage* into a collapsible bottom drawer, hides promotional cards, and coexists cleanly with extensions like Voyager.
- **Dark User Bubbles & Smart Folding** — Right-aligned dark bubbles for user turns that automatically collapse messages taller than `300px` into a `240px` fade-out preview with one-click expand/collapse.
- **Battery & GPU Relief** — Eliminates expensive `backdrop-filter` blurs (with solid theme-matched surfaces) and non-essential continuous animations while keeping loading spinners intact.

---

## Installation

> Supports **Google Chrome**, **Microsoft Edge**, **Brave**, **Arc**, and other Chromium-based browsers on `aistudio.google.com` and `aistudio.google.cn`.

### Option 1: Download Prebuilt Release (Recommended)

1. Download the latest archive: [**AI-Studio-Plus-WebExtension.zip**](https://github.com/NonTrivialLiu/ai-studio-plus/releases/latest/download/AI-Studio-Plus-WebExtension.zip)
2. Unzip it to a permanent folder on your computer (do not delete this folder after loading).
3. Open your browser's Extensions page:
   - Chrome / Arc / Brave: `chrome://extensions`
   - Microsoft Edge: `edge://extensions`
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder containing `manifest.json`.
6. Open or refresh [Google AI Studio](https://aistudio.google.com/).

### Option 2: Build from Source

Requires **Node.js >= 22**:

```bash
git clone https://github.com/NonTrivialLiu/ai-studio-plus.git
cd ai-studio-plus
npm run build
```

Then load the [`extension/`](extension/) directory via **Load unpacked** in `chrome://extensions`.

### How to Update

Download and unzip the new release over the same folder (or run `git pull && npm run build`), click the **Reload (↻)** button on the **AI Studio Plus** card in `chrome://extensions`, and refresh AI Studio.

---

## Shortcuts & Gestures

| Action | Shortcut / Gesture |
|---|---|
| Toggle left sidebar | `⌘ + B` (macOS) / `Ctrl + B` (Windows/Linux) |
| Hover-preview collapsed sidebar / Run settings | Hover over the native toggle button (`300ms`) |
| Open chat in current tab | Click row |
| Open chat in new tab / window | `⌘ + Click` / `Ctrl + Click` / `Shift + Click` |
| Rename chat inline | Double-click row or press `F2` |
| Open row context menu | Click `⋮` button or right-click row |
| Enter multi-select mode | Long-press row (`~500ms`) or click selection icon |
| Cancel / Close menu, preview, or selection | `Esc` |

---

## Privacy & Security

- **Zero Permissions** — Requests no special `chrome.*` permissions in [`manifest.json`](extension/manifest.json).
- **Zero Background Workers** — No persistent background service worker; runs strictly on `aistudio.google.com` and `aistudio.google.cn`.
- **Zero Telemetry or External Servers** — Reuses your existing signed-in Google AI Studio session directly. Chat metadata (ID, title, timestamp) is cached only in your browser tab's `sessionStorage`.
- **Trusted Types Compliant** — Built strictly with native DOM APIs (`createElement` / `textContent`), zero `innerHTML` or dynamic `eval`.

---

## FAQ

<details>
<summary><strong>Does it work with Dark Mode and Light Mode?</strong></summary>
<p>Yes. All extension surfaces, borders, hover highlights, and semantic danger controls inherit AI Studio's theme tokens with matched <code>light-dark()</code> fallbacks.</p>
</details>

<details>
<summary><strong>Is Firefox supported?</strong></summary>
<p>Firefox 128+ supports Manifest V3 <code>MAIN</code> world content scripts, but Firefox behavior has not been formally tested yet. Chromium browsers are the primary supported target.</p>
</details>

<details>
<summary><strong>What if Google AI Studio updates its layout and the sidebar stops showing?</strong></summary>
<p>AI Studio Plus relies on Google AI Studio's internal DOM and RPC endpoints. If a site update changes them, please check <a href="https://github.com/NonTrivialLiu/ai-studio-plus/releases">Releases</a> for an update or <a href="https://github.com/NonTrivialLiu/ai-studio-plus/issues/new/choose">open a Bug Report</a>.</p>
</details>

---

## Contributing & License

Contributions, bug reports, and UI/UX suggestions are warmly welcome!

- Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up local development, tests, and submit a Pull Request.
- Explore [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the `MAIN` / `ISOLATED` scripts interact.

Licensed under the [MIT License](LICENSE).
