<div align="center">

<img src="docs/assets/logo.png" width="108" height="108" alt="AI Studio Plus" />

<h1>AI Studio Plus</h1>

<p><strong>Turn Google AI Studio's left sidebar into an instant, searchable, multi-selectable chat workspace — with smart user bubble folding and GPU/battery optimizations.</strong></p>

<p>
  <a href="README.md"><img src="https://img.shields.io/badge/English-1a73e8?style=for-the-badge" alt="English" /></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-30363d?style=for-the-badge" alt="简体中文" /></a>
</p>

<p>
  <a href="https://github.com/NonTrivialLiu/ai-studio-plus/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/NonTrivialLiu/ai-studio-plus/build.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI" alt="CI" /></a>
  <a href="https://github.com/NonTrivialLiu/ai-studio-plus/releases/latest"><img src="https://img.shields.io/github/v/release/NonTrivialLiu/ai-studio-plus?style=flat-square&logo=github&label=Release&color=1a73e8" alt="Latest Release" /></a>
  <a href="extension/manifest.json"><img src="https://img.shields.io/badge/Chrome%20%7C%20Edge-Manifest%20V3-0f9d58?style=flat-square&logo=googlechrome&logoColor=white" alt="Manifest V3" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Dependencies-Zero-2ea44f?style=flat-square" alt="Zero Dependencies" /></a>
  <a href="extension/manifest.json"><img src="https://img.shields.io/badge/Permissions-Zero-2ea44f?style=flat-square" alt="Zero Permissions" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License" /></a>
</p>

<p>
  <a href="https://microsoftedge.microsoft.com/addons/detail/eifhmhfhjbjngdiekafiladfkegeapbj">
    <img src="https://img.shields.io/badge/Microsoft_Edge-Add--ons_Store-0078d7?style=for-the-badge&logo=microsoftedge&logoColor=white" alt="Install from Microsoft Edge Add-ons" />
  </a>
  &nbsp;
  <a href="https://github.com/NonTrivialLiu/ai-studio-plus/releases/latest/download/AI-Studio-Plus-WebExtension.zip">
    <img src="https://img.shields.io/badge/Download_Release-ZIP-1a73e8?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Download Latest Release ZIP" />
  </a>
</p>

<p>
  <sub>
    <a href="#live-demos">Live Demos</a> &nbsp;&bull;&nbsp;
    <a href="#features">Features</a> &nbsp;&bull;&nbsp;
    <a href="#installation">Installation</a> &nbsp;&bull;&nbsp;
    <a href="#shortcuts--gestures">Shortcuts</a> &nbsp;&bull;&nbsp;
    <a href="#privacy--security">Privacy</a> &nbsp;&bull;&nbsp;
    <a href="#contributing--license">Contributing</a>
  </sub>
</p>

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/preview-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/preview-light.png" />
  <img src="docs/assets/preview-light.png" width="94%" alt="AI Studio Plus Workspace Preview" />
</picture>

<br />
<sub>Automatically matches your GitHub Light / Dark theme &mdash; seamless native Google AI Studio integration with zero visual clutter.</sub>

</div>

---

## Why AI Studio Plus?

Google AI Studio's default navigation tucks your recent prompts away on a separate History page, lacks quick sidebar actions, renders ultra-long user prompts uncollapsed, and uses heavy CSS `backdrop-filter` / transition animations that warm up laptops.

**AI Studio Plus** upgrades the entire workspace in-place across **Light & Dark themes** — with **zero extra permissions**, **zero background workers**, **zero npm runtime dependencies**, and **zero third-party servers**.

---

## Live Demos

<div align="center">

### 1. Infinite History, Instant Search, Multi-Select & Bubble Folding

<img src="docs/assets/demo-sidebar.gif" width="92%" alt="AI Studio Plus Sidebar, Search, Multi-Select and Bubble Folding Demo" />

<br />
<sub>Calendar-grouped history scroll, live multi-page search filtering, row context menu, multi-select trash bar, and long prompt folding in Light Mode.</sub>

<br /><br />

### 2. Dark Mode & Hover-to-Peek Sidebars with Pinning

<img src="docs/assets/demo-peek-dark.gif" width="92%" alt="AI Studio Plus Dark Mode and Hover-to-Peek Sidebars Demo" />

<br />
<sub>Hover collapsed left navigation or right <em>Run settings</em> toggle to preview without shifting your prompt canvas — click the pin icon to lock open.</sub>

</div>

---

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>&#x1F4C5; Native Infinite History Sidebar</h3>
      <p>Groups chats automatically by calendar day (<em>Today</em>, <em>Yesterday</em>, <em>Previous 7 days</em>, <em>Previous 30 days</em>, <em>Earlier</em>), streams older pages on scroll, and switches chats instantly without full page reloads.</p>
    </td>
    <td width="50%" valign="top">
      <h3>&#x1F50D; Instant Full-History Search</h3>
      <p>Filters loaded conversations as you type and transparently paginates older history in the background until matches appear or history ends.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>&#x26A1; Fast Inline &amp; Menu Actions</h3>
      <p>Click to open, double-click or press <code>F2</code> to rename inline (IME-safe), or use <code>&#x22EE;</code> / right-click for <strong>Rename</strong>, <strong>Share</strong> (native Google Drive dialog), <strong>Make a copy</strong>, <strong>Select</strong>, and <strong>Delete</strong>.</p>
    </td>
    <td width="50%" valign="top">
      <h3>&#x2611;&#xFE0F; Multi-Select &amp; Batch Trash</h3>
      <p>Long-press any row (<code>~500ms</code>) or click the list selection icon to batch-select chats across searches and move them to Trash in one guided flow.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>&#x1F4CC; Hover-to-Peek Sidebars &amp; Pin</h3>
      <p>Hover the collapsed left sidebar or right <em>Run settings</em> toggle to peek overlay panels without reflowing the editor; click the pin icon to lock open, or press <code>&#x2318;B</code> / <code>Ctrl+B</code>.</p>
    </td>
    <td width="50%" valign="top">
      <h3>&#x1F9E9; Compact Nav &amp; Extension Coexistence</h3>
      <p>Tucks <em>Explore / Build / Manage</em> into an expandable bottom drawer, removes promotional upsell cards, and coexists cleanly with extensions like Voyager.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>&#x1F4AC; Dark User Bubbles &amp; Folding</h3>
      <p>Right-aligned user prompt bubbles automatically collapse messages taller than <code>300px</code> into a clean <code>240px</code> fade-out preview with one-click expand/collapse.</p>
    </td>
    <td width="50%" valign="top">
      <h3>&#x1F50B; Battery, GPU &amp; Latency Relief</h3>
      <p>Removes overlay <code>backdrop-filter</code> blurs and universal CSS transition scans, skips off-screen history row paint via <code>content-visibility: auto</code>, scopes observers away from virtualized scrolling with passive scroll yielding, prevents narrow-viewport sidebar gap, and preconnects key origins at <code>document_start</code>.</p>
    </td>
  </tr>
</table>

---

## Installation

Works on **Microsoft Edge**, **Google Chrome**, **Brave**, **Arc**, **Vivaldi**, **Opera**, and any other Chromium-based browser on `aistudio.google.com` and `aistudio.google.cn`.

| Browser | Recommended Install | Alternative |
|---|---|---|
| **Microsoft Edge** | [**Microsoft Edge Add-ons Store**](https://microsoftedge.microsoft.com/addons/detail/eifhmhfhjbjngdiekafiladfkegeapbj) *(1-Click & Auto-Update)* | [Option 1 (Release ZIP)](#option-1-install-from-release-zip-all-browsers--no-store-wait) (`edge://extensions`) |
| **Google Chrome** | [Option 1 (Release ZIP)](#option-1-install-from-release-zip-all-browsers--no-store-wait) (`chrome://extensions`) | Not on Chrome Web Store yet (~30s via ZIP) |
| **Brave / Arc / Vivaldi / Opera** | [Option 1 (Release ZIP)](#option-1-install-from-release-zip-all-browsers--no-store-wait) (`chrome://extensions`) | Build from source (Option 3) |

### Option 1: Install from Release ZIP *(All Browsers &bull; No Store Wait)*

> No coding or terminal needed &mdash; takes ~30 seconds.

1. **Download** the latest package: [**AI-Studio-Plus-WebExtension.zip**](https://github.com/NonTrivialLiu/ai-studio-plus/releases/latest/download/AI-Studio-Plus-WebExtension.zip).
2. **Unzip to a permanent folder** *(do **not** delete or move this folder after installing, or your browser will unload the extension)*:
   - **macOS**: Move the ZIP out of `Downloads` (e.g., to `~/Applications/Extensions/` or `Documents/Extensions/`) and double-click to extract.
   - **Windows**: Right-click the ZIP &rarr; **Extract All...** &rarr; pick a permanent path like `C:\Extensions\AI-Studio-Plus`.
   - Open the extracted folder and make sure you see **`manifest.json`** directly inside it *(if there is a nested folder with the same name, open one level deeper)*.
3. **Open your browser's Extensions page**:
   - **Chrome / Arc / Brave / Opera**: paste `chrome://extensions` into the address bar and press Enter.
   - **Microsoft Edge**: paste `edge://extensions` into the address bar and press Enter.
4. **Enable Developer mode**:
   - **Chrome / Brave**: switch ON the **Developer mode** toggle in the top-right corner.
   - **Edge**: switch ON the **Developer mode** toggle in the bottom-left sidebar (or top-right on newer layouts).
5. **Load the extension** *(either method works)*:
   - **Fastest**: Drag and drop the extracted folder (containing `manifest.json`) directly onto the Extensions page.
   - **Manual**: Click **Load unpacked** (or **Load unpacked extension**) and select that extracted folder.
6. **Start using**: Open or refresh [**Google AI Studio**](https://aistudio.google.com/) (`aistudio.google.com` or `aistudio.google.cn`). Pin the icon from your toolbar puzzle piece if desired!

<details>
<summary><strong>Troubleshooting: Common First-Time Install Questions</strong></summary>

- **"Manifest file is missing or unreadable"**: You probably selected an outer parent folder. Select the inner folder that directly contains `manifest.json`, `content.js`, and `icons/`.
- **Extension disappeared after reboot / cleanup**: Browsers read unpacked extensions directly from disk; avoid keeping the folder in temporary folders you clean regularly. Just unzip again to a safe folder and reload once.
- **Warning banner "Disable developer mode extensions"**: Normal Chromium prompt for local unpacked extensions; click Cancel/dismiss to keep using it.

</details>

### Option 2: Microsoft Edge Add-ons *(1-Click Install)*

Available live on the official [**Microsoft Edge Add-ons Store**](https://microsoftedge.microsoft.com/addons/detail/eifhmhfhjbjngdiekafiladfkegeapbj) &mdash; click **Get** to install with automatic background updates on Edge (no Developer mode needed). Using **Chrome, Brave, Arc, Vivaldi, or Opera**? Use **Option 1** above for the exact same build.

### Option 3: Build from Source

Requires **Node.js &ge; 22** (zero runtime dependencies):

```bash
git clone https://github.com/NonTrivialLiu/ai-studio-plus.git
cd ai-studio-plus
npm run build
```

Then load the generated [`extension/`](extension/) directory via **Load unpacked** on `chrome://extensions` or `edge://extensions`.

### How to Update

1. Download the newest `AI-Studio-Plus-WebExtension.zip` and extract it **overwriting the same folder** (or run `git pull && npm run build`).
2. Open `chrome://extensions` (or `edge://extensions`) and click **Reload (&#x21BB;)** on the **AI Studio Plus** card.
3. Refresh your Google AI Studio tab.

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

- **Zero Permissions** — [`manifest.json`](extension/manifest.json) requests **no** extra `chrome.*` permissions.
- **Zero Background Workers** — No persistent background service worker; runs strictly on `aistudio.google.com` and `aistudio.google.cn`.
- **Zero Telemetry or External Servers** — Reuses your existing signed-in Google AI Studio session directly. Chat metadata (ID, title, timestamp) is cached only in your browser tab's `sessionStorage`.
- **Strict Trusted Types Compliant** — Built purely with native DOM APIs (`createElement` / `textContent`), zero `innerHTML`, and zero dynamic `eval`.
- Read the full [Privacy Policy](PRIVACY.md) for store compliance details.

---

## FAQ

<details>
<summary><strong>Does it work with Dark Mode and Light Mode?</strong></summary>
<p>Yes. All extension surfaces, borders, hover highlights, and semantic danger controls inherit AI Studio's theme tokens with matched <code>light-dark()</code> fallbacks.</p>
</details>

<details>
<summary><strong>Initial page load still feels slow behind a VPN &mdash; why, and what helps?</strong></summary>
<p>Browser profiling shows ~95% of initial load delay on VPNs comes from multi-domain RPC/CORS round-trips rather than CPU rendering. While AI Studio Plus preconnects high-latency origins at <code>document_start</code>, keeping a zero-permission design means it intentionally avoids spoofing private Google APIs. For the fastest startup behind a proxy: <strong>(1)</strong> pin all <code>*.google.com</code> / <code>*.gstatic.com</code> / <code>*.clients6.google.com</code> domains to a single low-latency HTTP/2 node, <strong>(2)</strong> set <code>www.googletagmanager.com</code> and <code>play.google.com</code> to <code>REJECT</code> instead of letting telemetry hang, and <strong>(3)</strong> keep disk caching enabled so <code>gstatic.com</code> JS bundles (~2 MB) stay cached.</p>
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
