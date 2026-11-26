# Contributing to AI Studio Plus

Thank you for your interest in contributing to **AI Studio Plus**! This guide covers how to report bugs, propose features, set up a local development environment, and submit Pull Requests.

---

## Ways to Contribute

### 1. Report a Bug
Before opening a new issue, please search [existing issues](https://github.com/NonTrivialLiu/ai-studio-plus/issues) to avoid duplicates. When filing a [Bug Report](.github/ISSUE_TEMPLATE/bug_report.yml), include:
- Browser & OS version (e.g., Chrome 145 on macOS) and extension version
- Light or Dark theme
- Clear reproduction steps and any Console / Trusted Types errors
- Optional read-only diagnostics by pasting [`tests/inspect.js`](tests/inspect.js) into DevTools Console on an active AI Studio chat page (scrub any private chat titles before sharing)

### 2. Suggest a Feature
Open a [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) describing the problem and expected UX. Please keep the project's core philosophy in mind:
- **Zero runtime dependencies**
- **Zero extra `chrome.*` permissions & zero background service workers**
- **Native visual alignment** with Google AI Studio

### 3. Submit a Pull Request
Code fixes, test improvements, UI/UX refinements, and documentation updates are all welcome via Pull Requests!

---

## Local Development Setup

### Prerequisites
- **Node.js >= 22** (no third-party `npm install` dependencies required)
- **Chromium / Chrome for Testing** (for browser integration tests and local CDP debugging; e.g. cached via `npx playwright install chromium`)

### Setup & Build
```bash
git clone https://github.com/NonTrivialLiu/ai-studio-plus.git
cd ai-studio-plus
npm run setup:hooks   # Enable .githooks/pre-commit (runs lint + unit tests before each commit)
npm run build         # Bundle extension/src/* and extension/styles/* into extension/content.* & interceptor.js
```

> **Important**: Only edit files under `extension/src/` and `extension/styles/`. Do **not** hand-edit generated bundles (`extension/content.js`, `extension/interceptor.js`, `extension/content.css`); always regenerate them via `npm run build`.

### Live Browser Debugging (Chrome for Testing + CDP)
Official Google Chrome (137+) blocks `--load-extension` from the CLI. For fast local iteration, use the built-in **Chrome for Testing + CDP** workflow:

```bash
npm run dev:chrome          # Build & launch Chrome with extension/ loaded and CDP on port 9222
npm run dev:watch           # Watch src/ and styles/, rebuild, reload extension, and refresh AI Studio tabs
npm run debug:cdp status    # Check browser version, extension status, and open tabs
npm run debug:cdp reload    # Rebuild, reload extension via chrome://extensions, and refresh AI Studio tabs
npm run debug:cdp inspect   # Run tests/inspect.js on the active AI Studio chat tab
npm run debug:cdp console   # Stream console.* logs and uncaught exceptions in real time
```

For real-site write tests (rename, copy, delete), always use a clearly disposable test prompt and clean it up afterward.

---

## Project Structure & Coding Standards

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [AGENTS.md](AGENTS.md) for the full module map and engineering rules. Key constraints enforced automatically by `npm run lint`:

- **Classic IIFE Scripts**: Files in `extension/src/*.js` are concatenated in order by `scripts/build.mjs` — do not use ESM `import`/`export`. Keep each file `<= 500` lines.
- **Global Namespace**: Expose cross-module APIs exclusively on `globalThis.AIP*` (never `window.AIP*`).
- **Trusted Types Compliance**: Google AI Studio enforces Trusted Types. Build all DOM nodes with `document.createElement` and `textContent`. Never use `.innerHTML`, `.outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or `new Function`.
- **Zero Permissions / Zero Debug Residue**: Do not use undeclared `chrome.*` APIs, `console.log`, `debugger`, or machine-local absolute paths.
- **Theme & Accessibility**: Reuse shared `--aip-*` variables with `light-dark(...)` fallbacks defined in `extension/styles/sidebar.css`, ensure `:focus-visible` outlines on interactive elements, and test both Light and Dark themes.

---

## Testing & Quality Gates

All automated tests run locally without needing a Google account (using the built-in fixture server in `tests/browser/server.mjs`):

```bash
npm run lint          # Static & architecture checks (syntax, Trusted Types, bundle sync, CSS tokens)
npm test              # npm run lint + 87 unit tests
npm run test:browser  # 53 real-extension browser integration, smoke, and hover-peek tests
npm run test:ci       # Full CI check (lint + unit + browser, without overwriting stale bundles)
npm run package       # Build & verify build/AI-Studio-Plus-WebExtension.zip
```

When adding or modifying behavior:
- Add unit tests in `tests/unit/` covering normal paths, boundaries, and failure modes.
- Add or update browser assertions in `tests/browser/` using condition waits (`tab.waitFor`), ensuring zero uncaught page exceptions (`Runtime.exceptionThrown === 0`).

---

## Pull Request & Review Workflow

1. **Fork & Branch**: Fork the repository and create a descriptive branch from `main` (e.g., `fix/rename-ime-guard` or `feat/compact-scroll-polish`).
2. **Keep Changes Scoped**: Focus each PR on one logical change so reviews stay fast and clear.
3. **Commit Clearly**: Describe *what* changed, *why*, and *how* you verified it.
4. **Verify Before Opening PR**: Ensure `npm run build` and `npm run test:ci` pass cleanly with zero warnings or errors.
5. **Open PR**: Fill out the [Pull Request template](.github/PULL_REQUEST_TEMPLATE.md). GitHub Actions will automatically run the `Lint & unit tests` and `Browser extension tests & package` jobs.
6. **Review & Merge**: Maintainers review for correctness, Trusted Types safety, UI consistency (Light/Dark), and test coverage. Once CI is green and review comments are resolved, PRs are merged into `main`.

---

## Release Process (Maintainers)

1. Bump `"version"` consistently in both `package.json` and `extension/manifest.json`.
2. Commit and push to `main`.
3. Create and push a matching tag:
   ```bash
   git tag -a vX.Y.Z -m "AI Studio Plus vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. GitHub Actions automatically runs `check` → `browser` → `release`, publishing the verified WebExtension zip and `SHA256SUMS.txt` on GitHub Releases.
