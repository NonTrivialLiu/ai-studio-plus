# AGENTS.md

Google AI Studio 浏览器扩展（Manifest V3，Node >=22，运行时零依赖）。保持改动最小化，直接对应当前任务。

## 目录与生成物边界

- **源码入口**：只修改 `extension/src/` 与 `extension/styles/`。
- **生成产物（勿手改）**：`extension/content.js`、`extension/interceptor.js`、`extension/content.css` 由 `scripts/build.mjs` 拼接生成；修改源码后必须运行 `npm run build`。
- **文档入口（One Home per Fact）**：架构与模块边界见 `docs/ARCHITECTURE.md`，安装与功能概览见 `README.md`。

## 代码、注释与样式规范（`npm run lint` 门禁）

- **模块边界**：`extension/src/*.js` 为经典 IIFE 脚本，禁止使用 ESM `import`/`export`；单文件不超过 500 行，按职责拆分（`sidebar-*.js` 挂载于临时 `__AIPSidebarParts` 并在 `sidebar.js` 末尾 `delete`）。
- **全局命名空间**：跨模块暴露统一使用 `globalThis.AIP*`（禁止 `window.AIP*` 或裸全局引用 `AIPSidebarSpace`）；`scripts/*.mjs` 禁止反向导入 `tests/`。
- **Trusted Types 安全**：站点启用 Trusted Types，严禁 `.innerHTML`、`.outerHTML`、`insertAdjacentHTML`、`document.write`、`eval`、`new Function` 与字符串参数 `setTimeout`；仅允许 DOM API（`createElement` / `textContent`）。
- **零权限与零调试残留**：禁止调用未在 `extension/manifest.json` 声明的 `chrome.*` API，禁止残留 `console.log`、`debugger` 或本机绝对路径（`/Users/`、`/Volumes/`）。
- **样式规范**：扩展色板、阴影与字体统一定义在 `extension/styles/sidebar.css` 的 `body`（`--aip-*`，必须使用 `light-dark(...)` 兼容深浅色主题）；所有交互控件必须提供 `:focus-visible` 焦点环，危险操作使用 `--aip-danger` / `--aip-danger-bg`；禁止 `@import` 与远程 `url(http...)`。
- **注释规范**：每个 `extension/src/*.js` 与 `scripts/*.mjs` 顶部必须有 `/** ... */` 中文模块头（标注 `MAIN` 或 `ISOLATED` 世界）；行内注释只写**意图与跨模块不变量**，不写代码复述或推理过程残留。

## 禁止事项（Hard Stops）

- 禁止手改生成的聚合文件，或在不运行 `npm run build` 的情况下提交源码改动。
- 禁止引入运行时 npm 依赖、后台 Service Worker 或扩展额外权限。
- 禁止编写"走流程"的弱测试：禁止仅靠固定 `sleep()` 赌时序而不等待真实状态条件；禁止断言内部私有变量名；浏览器测试不得放过未捕获页面异常或 Trusted Types 报错。

## 测试、门禁与 Git Hook（免登录）

```bash
npm run setup:hooks   # 启用本地 .githooks/pre-commit（提交前自动跑 lint + 单元测试）
npm run lint          # 零依赖静态与架构门禁（语法、Trusted Types、产物同步、版本、CSS 变量）
npm test              # npm run lint + 单元测试（node --test tests/unit，免登录）
npm run test:browser  # 真实加载扩展的集成/冒烟/左右栏悬浮测试（Chromium + 本地仿真站，免登录）
npm run test:ci       # lint + 单元测试 + 浏览器测试（不自动 build，复现 CI 严格检查）
npm run test:all      # 本地便捷命令：构建 + 全量测试
npm run package       # 构建并生成 build/AI-Studio-Plus-WebExtension.zip，且通过 unzip 完整性与清单校验
```

- **测试编写标准**：单元测试覆盖正常路径、边界与故障分支（空模板、文件夹透传、`AbortError` 超时、分页耗尽、内存/存储异常）；浏览器测试必须加载构建后的真实 `extension/` 产物，通过 `tab.waitFor` 等待可观察状态变化并断言 `Runtime.exceptionThrown === 0`。

## Chrome 开发与真站调试通路

正式版 Google Chrome（137+）拒绝命令行 `--load-extension`，且 Antigravity 内置 Electron 浏览器不支持加载 Chrome 扩展。真机扩展调试统一使用项目内置的 **Chrome for Testing + CDP** 通路：

```bash
npm run dev:chrome    # 构建并启动 Chrome for Testing（自动加载 extension/，开启 9222 端口）
npm run dev:watch     # 监听 extension/src 与 extension/styles，改动后串行构建、重载扩展并刷新标签页
npm run debug:cdp status   # 查看浏览器版本、AI Studio Plus 扩展状态与所有打开的标签页
npm run debug:cdp reload   # 重新构建、通过 chrome://extensions 重载扩展并刷新 AI Studio 标签页
npm run debug:cdp inspect  # 在当前 AI Studio 会话页执行 tests/inspect.js 并输出结构化结果
npm run debug:cdp console  # 实时流式输出目标页 console.* 与未捕获异常
```

- **持久化档案与环境变量**：调试档案默认位于 `~/.cache/ai-studio-plus/chrome-dev-profile`（可通过 `AIP_DEV_PROFILE` 覆盖），首次登录 Google 后保留登录态；CDP 端口默认 `9222`（`AIP_DEV_PORT` 可覆盖）；需要代理时传 `AIP_DEV_PROXY=http://127.0.0.1:18080`。
- **真站写操作边界**：`debug:cdp inspect` 停在 `accounts.google.com` 时需先完成登录；涉及改名、复制、删除验收仅使用明确可处置的临时测试副本，并在验证后清理。

## CI/CD 与开源发布（GitHub Actions）

- `.github/workflows/build.yml` 分三阶段执行：`check`（`npm test` 与 `v*` 标签版本校验）→ `browser`（缓存 Playwright Chromium，执行 `AIP_REQUIRE_BROWSER=1 npm run test:browser` 与 `npm run package` 并上传 artifact）→ `release`（仅 `v*` 标签触发，发布 `AI-Studio-Plus-WebExtension.zip`）。
- 发版前确保 `package.json` 与 `extension/manifest.json` 的 `version` 一致且等于 `v<version>`。
