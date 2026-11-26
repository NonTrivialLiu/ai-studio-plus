#!/usr/bin/env node
/**
 * 隐私隔离的真站高清晰度演示与截图录制脚本：
 * 连接已登录的本机开发 Chrome（`npm run dev:chrome`，默认端口 9222），打开临时标签页加载真实 Google AI Studio，
 * 在请求阶段拦截 MakerSuiteService 历史接口并注入全合成开发对话与脱敏账号名，
 * 以 2x HiDPI 录制并导出 README 使用的浅/深色截图与动图到 docs/assets/。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, connectWs } from './chromium.mjs';

const PORT = Number(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || process.env.AIP_DEV_PORT || 9222);
const ASSETS_DIR = join(ROOT, 'docs', 'assets');
const TARGET_URL = 'https://aistudio.google.com/prompts/new_chat';

const NOW_SEC = Math.floor(Date.now() / 1000);
const DAY_SEC = 86400;
const SYNTHETIC_CHATS = [
  { id: 'demo_01', title: 'Refactor React state machine', age: 1600 },
  { id: 'demo_02', title: 'WebGPU compute shader pass', age: 5200 },
  { id: 'demo_03', title: 'SQLite FTS5 ranking query', age: 14400 },
  { id: 'demo_04', title: 'TypeScript AST codemod helper', age: DAY_SEC + 3600 },
  { id: 'demo_05', title: 'Chromium extension CDP harness', age: DAY_SEC + 10800 },
  { id: 'demo_06', title: 'Docker multi-stage build cache', age: DAY_SEC + 28800 },
  { id: 'demo_07', title: 'Design system color tokens', age: 3 * DAY_SEC },
  { id: 'demo_08', title: 'Async retry queue with jitter', age: 4 * DAY_SEC },
  { id: 'demo_09', title: 'Postgres partial index tuning', age: 5 * DAY_SEC },
  { id: 'demo_10', title: 'CSS anchor positioning notes', age: 6 * DAY_SEC },
  { id: 'demo_11', title: 'GraphQL dataloader batching', age: 10 * DAY_SEC },
  { id: 'demo_12', title: 'Streaming SSE parser cleanup', age: 14 * DAY_SEC },
  { id: 'demo_13', title: 'Rust zero-copy ring buffer', age: 18 * DAY_SEC },
  { id: 'demo_14', title: 'WebAssembly SIMD benchmark', age: 24 * DAY_SEC },
  { id: 'demo_15', title: 'OAuth2 PKCE flow checklist', age: 40 * DAY_SEC },
  { id: 'demo_16', title: 'Nginx HTTP/3 QUIC tuning', age: 52 * DAY_SEC }
];
const ALLOWED_TITLES = new Set(SYNTHETIC_CHATS.map(c => c.title));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function encodePromptRecord(chat) {
  const sec = String(NOW_SEC - chat.age);
  return [`prompts/${chat.id}`, null, null, null, [chat.title, null, null, null, [[sec, 0], null]]];
}

function buildCorsHeaders(reqHeaders, extra = []) {
  const reqOrigin = reqHeaders?.origin || reqHeaders?.Origin || 'https://aistudio.google.com';
  return [
    { name: 'access-control-allow-origin', value: reqOrigin },
    { name: 'access-control-allow-credentials', value: 'true' },
    { name: 'access-control-allow-methods', value: 'GET, POST, OPTIONS' },
    { name: 'access-control-allow-headers', value: 'content-type, authorization, x-goog-api-key, x-goog-authuser, x-user-agent, x-client-data' },
    ...extra
  ];
}

async function createTempTab(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!res.ok) throw new Error(`无法通过 CDP 创建临时标签页 (HTTP ${res.status})`);
  return res.json();
}

async function closeTempTab(port, id) {
  if (!id) return;
  await fetch(`http://127.0.0.1:${port}/json/close/${id}`).catch(() => {});
}

async function evalInTab(client, fn, arg) {
  const expr = `(${fn})(${JSON.stringify(arg ?? null)})`;
  const reply = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (reply.exceptionDetails) {
    const detail = reply.exceptionDetails.exception?.description || reply.exceptionDetails.text;
    throw new Error(`页面脚本执行失败：${detail}`);
  }
  return reply.result?.value;
}

async function waitFor(fn, { timeout = 15000, interval = 80, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const val = await fn();
    if (val) return val;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(interval);
  }
}

function encodeGif(framesDir, outGif, { width = 1160, fps = 12 } = {}) {
  const palette = join(framesDir, 'palette.png');
  execFileSync('ffmpeg', [
    '-y', '-framerate', String(fps), '-i', join(framesDir, 'frame_%04d.png'),
    '-vf', `scale=${width}:-1:flags=lanczos,palettegen=max_colors=256:reserve_transparent=0:stats_mode=diff`,
    palette
  ], { stdio: 'inherit' });
  execFileSync('ffmpeg', [
    '-y', '-framerate', String(fps), '-i', join(framesDir, 'frame_%04d.png'), '-i', palette,
    '-lavfi', `scale=${width}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
    outGif
  ], { stdio: 'inherit' });
}

function saveHiDpiPng(rawPngBuf, outPng, { width = 1600 } = {}) {
  const tmpPng = `${outPng}.raw.png`;
  writeFileSync(tmpPng, rawPngBuf);
  try {
    execFileSync('ffmpeg', [
      '-y', '-i', tmpPng,
      '-vf', `scale=${width}:-1:flags=lanczos`,
      '-frames:v', '1', '-update', '1',
      outPng
    ], { stdio: 'inherit' });
  } finally {
    rmSync(tmpPng, { force: true });
  }
}

async function main() {
  mkdirSync(ASSETS_DIR, { recursive: true });
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
  } catch (_) {
    console.error(`未检测到运行中的 Chrome CDP（端口 ${PORT}）。请先运行 npm run dev:chrome 并确认已登录 aistudio.google.com。`);
    process.exit(1);
  }

  const target = await createTempTab(PORT);
  const client = await connectWs(target.webSocketDebuggerUrl, 30000);
  const tmpDirs = [];

  try {
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    // 页面运行前即清空 sessionStorage 中的真实历史缓存，并隐藏账户切换器直到脱敏完成
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        try {
          for (let i = sessionStorage.length - 1; i >= 0; i--) {
            const k = sessionStorage.key(i);
            if (k && /aip/i.test(k)) sessionStorage.removeItem(k);
          }
        } catch (_) {}
        const style = document.createElement('style');
        style.id = 'aip-demo-prehide';
        style.textContent = 'ms-account-switcher:not([data-aip-demo-sanitized]) { opacity: 0 !important; pointer-events: none !important; }';
        (document.head || document.documentElement).appendChild(style);
      })();`
    });

    // 在请求发出前拦截 MakerSuiteService，返回全合成历史并禁止任何写操作落到线上
    await client.send('Fetch.enable', {
      patterns: [{ urlPattern: '*MakerSuiteService*', requestStage: 'Request' }]
    });

    let sawListPrompts = false;
    client.onEvent(msg => {
      if (msg.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = msg.params;
      const url = request.url || '';
      const method = (request.method || 'GET').toUpperCase();

      if (method === 'OPTIONS') {
        client.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 204,
          responseHeaders: buildCorsHeaders(request.headers)
        }).catch(() => {});
        return;
      }

      if (url.includes('MakerSuiteService/ListPrompts')) {
        sawListPrompts = true;
        const body = JSON.stringify([SYNTHETIC_CHATS.map(encodePromptRecord), null]);
        client.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: buildCorsHeaders(request.headers, [
            { name: 'content-type', value: 'application/json+protobuf' }
          ]),
          body: Buffer.from(body).toString('base64')
        }).catch(() => {});
        return;
      }

      if (url.includes('MakerSuiteService/ResolveDriveResource')) {
        const body = JSON.stringify(encodePromptRecord(SYNTHETIC_CHATS[0]));
        client.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: buildCorsHeaders(request.headers, [
            { name: 'content-type', value: 'application/json+protobuf' }
          ]),
          body: Buffer.from(body).toString('base64')
        }).catch(() => {});
        return;
      }

      if (/MakerSuiteService\/(UpdatePrompt|CreatePrompt|DeletePrompt)/.test(url)) {
        const body = JSON.stringify(encodePromptRecord(SYNTHETIC_CHATS[0]));
        client.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: buildCorsHeaders(request.headers, [
            { name: 'content-type', value: 'application/json+protobuf' }
          ]),
          body: Buffer.from(body).toString('base64')
        }).catch(() => {});
        return;
      }

      client.send('Fetch.continueRequest', { requestId }).catch(() => {});
    });

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1180, height: 830, deviceScaleFactor: 2, mobile: false
    });
    await client.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-color-scheme', value: 'light' }]
    });

    await client.send('Page.navigate', { url: TARGET_URL });

    // 等待登录态、原生框架与扩展主体就位
    await waitFor(async () => {
      const state = await evalInTab(client, () => ({
        url: location.href,
        hasNav: !!document.querySelector('ms-navbar-v2 ms-nav-items-main-v2'),
        hasAccount: !!document.querySelector('ms-account-switcher'),
        hasExtension: !!document.querySelector('#aip-history'),
        hasView: !!document.querySelector('.chat-view-container'),
        hasRunSettings: !!document.querySelector('ms-run-settings')
      }));
      if (state?.url?.includes('accounts.google.com')) {
        throw new Error('当前开发 Chrome 未登录 Google AI Studio，请先在 dev:chrome 中完成登录后重试。');
      }
      return state?.hasNav && state?.hasAccount && state?.hasExtension && state?.hasView && state?.hasRunSettings;
    }, { timeout: 25000, label: 'AI Studio 与扩展加载' });

    // 若页面初始在 /prompts/new_chat 未主动请求 ListPrompts，触发一次合成拉取
    await sleep(1200);
    const initialRows = await evalInTab(client, () => document.querySelectorAll('#aip-history .aip-row').length);
    if (!sawListPrompts || initialRows < SYNTHETIC_CHATS.length) {
      await evalInTab(client, async () => {
        await fetch('/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts', {
          method: 'POST',
          headers: { 'content-type': 'application/json+protobuf' },
          body: JSON.stringify([100])
        });
      });
    }

    await waitFor(() => evalInTab(client, n => document.querySelectorAll('#aip-history .aip-row').length >= n, SYNTHETIC_CHATS.length), {
      timeout: 10000, label: '合成历史记录渲染'
    });

    // 脱敏账号栏、更新页面标题、在真实主区渲染高保真开发对话并注入模拟指针（严格使用 DOM API）
    await evalInTab(client, () => {
      document.body.classList.remove('dark-theme');
      document.body.classList.add('light-theme');

      const switcher = document.querySelector('ms-account-switcher');
      if (switcher) {
        const svgAvatar = 'data:image/svg+xml;utf8,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="18" fill="#1a73e8"/><text x="18" y="23" text-anchor="middle" fill="#fff" font-family="Inter,Arial,sans-serif" font-size="14" font-weight="600">AC</text></svg>'
        );
        switcher.querySelectorAll('img.avatar, img').forEach(img => {
          img.src = svgAvatar;
          img.removeAttribute('srcset');
          img.alt = 'Alex Chen';
        });
        const label = switcher.querySelector('.account-switcher-text');
        if (label) label.textContent = 'Alex Chen';
        for (const el of [switcher, ...switcher.querySelectorAll('*')]) {
          for (const attr of ['aria-label', 'title', 'data-email']) {
            const val = el.getAttribute(attr);
            if (val && val.includes('@')) el.setAttribute(attr, 'Alex Chen');
          }
        }
        switcher.setAttribute('data-aip-demo-sanitized', '1');
      }

      const titleEl = document.querySelector('.page-title');
      if (titleEl) {
        const walker = document.createTreeWalker(titleEl, NodeFilter.SHOW_TEXT);
        const firstText = walker.nextNode();
        if (firstText) firstText.nodeValue = 'Refactor React state machine';
        else titleEl.textContent = 'Refactor React state machine';
      }

      // 挂载 Demo 专属样式：忠实复刻真实 AI Studio 排版与代码块，同时提供平滑动画光标
      if (!document.getElementById('aip-demo-style')) {
        const style = document.createElement('style');
        style.id = 'aip-demo-style';
        style.textContent = `
          .aip-demo-thread {
            width: 100%;
            max-width: 780px;
            margin: 6px auto 120px;
            padding: 0 28px;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
          }
          .aip-demo-author {
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.2px;
            margin-bottom: 8px;
            color: var(--color-v3-text-var, #565b61);
          }
          .aip-demo-user-body p {
            margin: 0 0 10px;
            line-height: 1.55;
            font-size: 14px;
          }
          .aip-demo-user-body p:last-child { margin-bottom: 0; }
          .aip-demo-user-pre {
            margin: 10px 0;
            padding: 12px 14px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.12);
            font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
            white-space: pre;
            overflow-x: auto;
            color: #eef1f6;
          }
          .aip-demo-model-card {
            padding: 6px 4px 16px;
            color: var(--color-v3-text, #1b1b1e);
          }
          .aip-demo-thought-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            margin-bottom: 10px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 500;
            color: var(--color-v3-text-var, #565b61);
            background: var(--color-v3-surface-container, light-dark(#f4f5f7, #232428));
            border: 1px solid var(--color-v3-outline-var, light-dark(#e3e5e8, rgba(255,255,255,0.12)));
          }
          .aip-demo-model-pre {
            margin: 10px 0 0;
            padding: 14px 16px;
            border-radius: 12px;
            background: light-dark(#f6f7f9, #1b1c20);
            border: 1px solid var(--color-v3-outline-var, light-dark(#e3e5e8, rgba(255,255,255,0.1)));
            font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
            white-space: pre;
            overflow-x: auto;
            color: light-dark(#1b1b1e, #e4e6eb);
          }
          #aip-demo-cursor {
            position: fixed;
            left: 0;
            top: 0;
            margin: -3px 0 0 -4px;
            width: 24px;
            height: 24px;
            transform: translate(-60px, -60px);
            z-index: 2147483647;
            pointer-events: none;
            filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.35));
            transition: transform 45ms linear;
          }
          #aip-demo-cursor.clicking::after {
            content: "";
            position: absolute;
            left: -5px;
            top: -5px;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 2px solid #1a73e8;
            background: rgba(26, 115, 232, 0.16);
          }
        `;
        document.head.appendChild(style);
      }

      const view = document.querySelector('.chat-view-container');
      if (!view) throw new Error('未找到 .chat-view-container 容器');
      view.classList.remove('zero-state');
      const zeroState = view.querySelector('ms-zero-state');
      if (zeroState) zeroState.remove();

      const thread = document.createElement('div');
        thread.className = 'aip-demo-thread';

        const uTurn = document.createElement('ms-chat-turn');
        uTurn.id = 'aip-demo-u1';
        const uBox = document.createElement('div');
        uBox.className = 'chat-turn-container user render';
        const uAuthor = document.createElement('div');
        uAuthor.className = 'author-label aip-demo-author';
        uAuthor.textContent = 'User';
        const uPrompt = document.createElement('div');
        uPrompt.className = 'user-prompt-container';
        const uContent = document.createElement('div');
        uContent.className = 'turn-content aip-demo-user-body';

        const p1 = document.createElement('p');
        p1.textContent = 'Can you refactor this reducer-based workflow into a clean, zero-dependency state machine with explicit transitions, exhaustive error recovery, and predictable cleanup?';
        const pre1 = document.createElement('pre');
        pre1.className = 'aip-demo-user-pre';
        pre1.textContent = [
          "type Phase = 'idle' | 'loading' | 'ready' | 'error';",
          'interface MachineState<T> {',
          '  phase: Phase;',
          '  requestId: number;',
          '  items: T[];',
          '  cursor: string | null;',
          '}',
          'export function createMachine<T>(initial: Phase = "idle") {',
          '  let requestId = 0;',
          '  let controller: AbortController | null = null;',
          '  let state: MachineState<T> = {',
          '    phase: initial, requestId: 0, items: [], cursor: null',
          '  };',
          '  const listeners = new Set<(s: MachineState<T>) => void>();',
          '  function dispatch(event: { type: string; id?: number }) {',
          "    if (event.type === 'FETCH' && state.phase === 'idle') {",
          '      controller?.abort();',
          '      controller = new AbortController();',
          '      requestId += 1;',
          "      state = { ...state, phase: 'loading', requestId };",
          "    } else if (event.type === 'RESOLVE' && event.id === requestId) {",
          "      state = { ...state, phase: 'ready' };",
          "    } else if (event.type === 'RETRY' && state.phase === 'error') {",
          '      requestId += 1;',
          "      state = { ...state, phase: 'loading', requestId };",
          '    }',
          '    for (const fn of listeners) fn(state);',
          '  }',
          '  return { dispatch, getState: () => state };',
          '}'
        ].join('\n');
        const p2 = document.createElement('p');
        p2.textContent = 'Also keep every transition pure, guard against stale async responses using a monotonic requestId, and reset transient error flags cleanly on retry.';
        uContent.append(p1, pre1, p2);
        uPrompt.appendChild(uContent);
        uBox.append(uAuthor, uPrompt);
        uTurn.appendChild(uBox);

        const mTurn = document.createElement('ms-chat-turn');
        mTurn.id = 'aip-demo-m1';
        const mBox = document.createElement('div');
        mBox.className = 'chat-turn-container model render aip-demo-model-card';
        const mAuthor = document.createElement('div');
        mAuthor.className = 'aip-demo-author';
        mAuthor.textContent = 'Gemini 2.5 Pro';
        const pill = document.createElement('div');
        pill.className = 'aip-demo-thought-pill';
        pill.textContent = 'Thoughts · Thought for 2.4s';
        const mText = document.createElement('p');
        mText.style.margin = '0 0 8px';
        mText.style.lineHeight = '1.6';
        mText.textContent = 'Here is a deterministic transition table pattern with monotonic request guards, clean AbortController support, and zero external dependencies:';
        const pre2 = document.createElement('pre');
        pre2.className = 'aip-demo-model-pre';
        pre2.textContent = [
          'const TRANSITIONS = {',
          "  idle:    { FETCH: 'loading' },",
          "  loading: { RESOLVE: 'ready', FAIL: 'error', CANCEL: 'idle' },",
          "  ready:   { FETCH: 'loading', RESET: 'idle' },",
          "  error:   { RETRY: 'loading', RESET: 'idle' }",
          '} as const;'
        ].join('\n');
        mBox.append(mAuthor, pill, mText, pre2);
        mTurn.appendChild(mBox);

      thread.append(uTurn, mTurn);
      view.prepend(thread);
      view.scrollTop = 0;

      if (!document.getElementById('aip-demo-cursor')) {
        const cursor = document.createElement('div');
        cursor.id = 'aip-demo-cursor';
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M4 3L19 11.5L11.8 13.4L8.8 20.5L4 3Z');
        path.setAttribute('fill', '#111111');
        path.setAttribute('stroke', '#FFFFFF');
        path.setAttribute('stroke-width', '1.8');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        cursor.appendChild(svg);
        document.body.appendChild(cursor);
      }
    });

    // 等待用户消息折叠按钮激活
    await waitFor(() => evalInTab(client, () => {
      const btn = document.querySelector('#aip-demo-u1 .aib-toggle');
      return !!btn && !btn.hidden;
    }), { timeout: 10000, label: '用户长气泡折叠按钮就绪' });

    // 强制隐私拦截门禁：截屏前确认零邮箱特征、零真实对话标题
    const privacyAudit = await evalInTab(client, allowed => {
      const text = document.body.innerText || '';
      const hasAtSymbol = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text);
      const rowTitles = Array.from(document.querySelectorAll('#aip-history .aip-row .aip-row-title')).map(el => el.textContent.trim());
      const unexpectedTitles = rowTitles.filter(t => !allowed.includes(t));
      const switcher = document.querySelector('ms-account-switcher');
      const switcherText = switcher?.innerText?.trim() || '';
      return { hasAtSymbol, unexpectedTitles, switcherText, rowCount: rowTitles.length };
    }, [...ALLOWED_TITLES]);

    if (privacyAudit.hasAtSymbol || privacyAudit.unexpectedTitles.length || privacyAudit.rowCount < SYNTHETIC_CHATS.length) {
      throw new Error(`隐私校验失败：${JSON.stringify(privacyAudit)}`);
    }
    console.log(`隐私校验通过：账户=${privacyAudit.switcherText}，合成会话数=${privacyAudit.rowCount}`);

    let curX = 520;
    let curY = 320;
    const setCursor = (x, y, clicking = false) => evalInTab(client, ({ x, y, clicking }) => {
      const c = document.getElementById('aip-demo-cursor');
      if (!c) return;
      c.style.transform = `translate(${x}px, ${y}px)`;
      c.classList.toggle('clicking', clicking);
    }, { x, y, clicking });

    const captureFrame = async (dir, counter, repeat = 1) => {
      const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(data, 'base64');
      for (let i = 0; i < repeat; i++) {
        writeFileSync(join(dir, `frame_${String(counter.n++).padStart(4, '0')}.png`), buf);
      }
    };

    const smoothMove = async (tx, ty, dir, counter, steps = 8) => {
      const sx = curX;
      const sy = curY;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = 1 - Math.pow(1 - t, 3);
        const nx = sx + (tx - sx) * ease;
        const ny = sy + (ty - sy) * ease;
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nx, y: ny });
        await setCursor(nx, ny, false);
        if (dir) await captureFrame(dir, counter);
        await sleep(28);
      }
      curX = tx;
      curY = ty;
    };

    const smoothClick = async (tx, ty, dir, counter) => {
      await smoothMove(tx, ty, dir, counter, 5);
      await setCursor(tx, ty, true);
      if (dir) await captureFrame(dir, counter, 1);
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1 });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 });
      await setCursor(tx, ty, false);
      if (dir) await captureFrame(dir, counter, 2);
    };

    // 1. 拍摄 Light Mode 全景高清截图 (preview-light.png)
    await setCursor(-48, -48, false);
    await sleep(150);
    const lightPng = await client.send('Page.captureScreenshot', { format: 'png' });
    saveHiDpiPng(Buffer.from(lightPng.data, 'base64'), join(ASSETS_DIR, 'preview-light.png'), { width: 1600 });

    // 2. 录制 GIF 1：浅色放大视角 — 历史滚动、即时搜索、三点菜单、多选整理与长气泡展开折叠
    await evalInTab(client, () => {
      document.querySelector('button[aria-label="Close run settings panel"]')?.click();
    });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1024, height: 640, deviceScaleFactor: 2, mobile: false
    });
    await sleep(220);

    const frames1 = mkdtempSync(join(tmpdir(), 'aip-gif1-'));
    tmpDirs.push(frames1);
    const c1 = { n: 0 };
    curX = 460;
    curY = 280;
    await setCursor(-48, -48, false);
    await captureFrame(frames1, c1, 8);

    // 滚动历史流
    await smoothMove(110, 270, frames1, c1, 7);
    for (let i = 0; i < 4; i++) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 110, y: 270, deltaX: 0, deltaY: 85 });
      await sleep(50);
      await captureFrame(frames1, c1, 2);
    }
    for (let i = 0; i < 4; i++) {
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 110, y: 270, deltaX: 0, deltaY: -85 });
      await sleep(50);
      await captureFrame(frames1, c1, 2);
    }

    // 即时搜索 "WebGPU"
    const searchCenter = await evalInTab(client, () => {
      const r = document.querySelector('.aip-search-input').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothClick(searchCenter.x, searchCenter.y, frames1, c1);
    for (const ch of 'WebGPU') {
      await client.send('Input.insertText', { text: ch });
      await sleep(55);
      await captureFrame(frames1, c1, 2);
    }
    await waitFor(() => evalInTab(client, () => {
      const clear = document.querySelector('.aip-search-clear');
      const visible = document.querySelectorAll('#aip-history .aip-row:not([hidden])').length;
      return !!clear && !clear.hidden && clear.getBoundingClientRect().width > 0 && visible <= 2;
    }), { timeout: 8000, label: '搜索过滤与清除按钮就绪' });
    await captureFrame(frames1, c1, 10);

    // 清空搜索
    const clearCenter = await evalInTab(client, () => {
      const r = document.querySelector('.aip-search-clear').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothClick(clearCenter.x, clearCenter.y, frames1, c1);
    await waitFor(() => evalInTab(client, n =>
      document.querySelectorAll('#aip-history .aip-row:not([hidden])').length >= n, SYNTHETIC_CHATS.length
    ), { timeout: 8000, label: '清空搜索恢复全量列表' });
    await captureFrame(frames1, c1, 4);

    // 悬停可见的第 2 行，确认三点按钮可见且可点击后再点击
    const row2Pos = await evalInTab(client, () => {
      const r = document.querySelectorAll('#aip-history .aip-row:not([hidden])')[1];
      r.scrollIntoView({ block: 'nearest' });
      const rr = r.getBoundingClientRect();
      return { rx: rr.x + 84, ry: rr.y + rr.height / 2 };
    });
    await smoothMove(row2Pos.rx, row2Pos.ry, frames1, c1, 6);
    await waitFor(() => evalInTab(client, () => {
      const btn = document.querySelectorAll('#aip-history .aip-row:not([hidden])')[1]?.querySelector('.aip-row-menu');
      if (!btn) return false;
      const cs = getComputedStyle(btn);
      const mr = btn.getBoundingClientRect();
      return cs.pointerEvents !== 'none' && Number(cs.opacity) > 0.5 && mr.width > 0;
    }), { timeout: 5000, label: '行尾三点菜单按钮激活' });
    await captureFrame(frames1, c1, 3);
    const menuBtnPos = await evalInTab(client, () => {
      const r = document.querySelectorAll('#aip-history .aip-row:not([hidden])')[1];
      const mr = r.querySelector('.aip-row-menu').getBoundingClientRect();
      return { mx: mr.x + mr.width / 2, my: mr.y + mr.height / 2 };
    });
    await smoothClick(menuBtnPos.mx, menuBtnPos.my, frames1, c1);
    await waitFor(() => evalInTab(client, () => !!document.querySelector('.aip-menu')), { timeout: 5000, label: '行三点菜单展开' });
    await captureFrame(frames1, c1, 12);

    // 点击菜单 Select 进入多选模式并再选一行
    const selMenuPos = await evalInTab(client, () => {
      const r = document.querySelector('.aip-menu-item[data-action="select"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothClick(selMenuPos.x, selMenuPos.y, frames1, c1);
    const row3Pos = await evalInTab(client, () => {
      const r = document.querySelectorAll('#aip-history .aip-row:not([hidden])')[2].getBoundingClientRect();
      return { x: r.x + 84, y: r.y + r.height / 2 };
    });
    await smoothClick(row3Pos.x, row3Pos.y, frames1, c1);
    await captureFrame(frames1, c1, 10);

    // 退出多选模式
    const exitSelPos = await evalInTab(client, () => {
      const r = document.querySelector('.aip-selection-exit').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothClick(exitSelPos.x, exitSelPos.y, frames1, c1);

    // 展开用户长气泡并再折叠回去
    const togglePos1 = await evalInTab(client, () => {
      const r = document.querySelector('#aip-demo-u1 .aib-toggle').getBoundingClientRect();
      return { x: r.x + 36, y: r.y + r.height / 2 };
    });
    await smoothClick(togglePos1.x, togglePos1.y, frames1, c1);
    await captureFrame(frames1, c1, 12);
    const togglePos2 = await evalInTab(client, () => {
      const r = document.querySelector('#aip-demo-u1 .aib-toggle').getBoundingClientRect();
      return { x: r.x + 36, y: r.y + r.height / 2 };
    });
    await smoothClick(togglePos2.x, togglePos2.y, frames1, c1);
    await captureFrame(frames1, c1, 8);

    encodeGif(frames1, join(ASSETS_DIR, 'demo-sidebar.gif'), { width: 1200, fps: 12 });

    // 3. 切换至真实深色主题 + 恢复 Run settings，拍摄 preview-dark.png
    await evalInTab(client, () => {
      document.body.classList.remove('light-theme');
      document.body.classList.add('dark-theme');
      document.querySelector('.runsettings-toggle-button')?.click();
    });
    await client.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-color-scheme', value: 'dark' }]
    });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1180, height: 830, deviceScaleFactor: 2, mobile: false
    });
    await sleep(250);

    await setCursor(-48, -48, false);
    const darkRowHover = await evalInTab(client, () => {
      const rr = document.querySelectorAll('#aip-history .aip-row')[1].getBoundingClientRect();
      return { rx: rr.x + 84, ry: rr.y + rr.height / 2 };
    });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: darkRowHover.rx, y: darkRowHover.ry });
    await sleep(60);
    const darkMenuBtn = await evalInTab(client, () => {
      const mr = document.querySelectorAll('#aip-history .aip-row')[1].querySelector('.aip-row-menu').getBoundingClientRect();
      return { mx: mr.x + mr.width / 2, my: mr.y + mr.height / 2 };
    });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: darkMenuBtn.mx, y: darkMenuBtn.my });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: darkMenuBtn.mx, y: darkMenuBtn.my, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: darkMenuBtn.mx, y: darkMenuBtn.my, button: 'left', clickCount: 1 });
    await waitFor(() => evalInTab(client, () => !!document.querySelector('.aip-menu')));
    await sleep(100);
    const darkPng = await client.send('Page.captureScreenshot', { format: 'png' });
    saveHiDpiPng(Buffer.from(darkPng.data, 'base64'), join(ASSETS_DIR, 'preview-dark.png'), { width: 1600 });

    // 关闭菜单，准备录制深色左右栏悬浮预览 GIF
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 540, y: 500, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 540, y: 500, button: 'left', clickCount: 1 });
    await waitFor(() => evalInTab(client, () => !document.querySelector('.aip-menu')));

    // 4. 录制 GIF 2：深色放大视角 — 左右栏收起、悬停悬浮预览与图钉固定
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1120, height: 680, deviceScaleFactor: 2, mobile: false
    });
    await sleep(200);

    const frames2 = mkdtempSync(join(tmpdir(), 'aip-gif2-'));
    tmpDirs.push(frames2);
    const c2 = { n: 0 };
    curX = 520;
    curY = 260;
    await setCursor(curX, curY, false);
    await captureFrame(frames2, c2, 7);

    // 收起左侧导航并移开鼠标
    const collapseNavPos = await evalInTab(client, () => {
      const r = document.querySelector('button[aria-label="Collapse navigation menu"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothClick(collapseNavPos.x, collapseNavPos.y, frames2, c2);
    await waitFor(() => evalInTab(client, () => !!document.querySelector('button[aria-label="Open navigation menu"]')));
    await smoothMove(320, 200, frames2, c2, 5);
    await captureFrame(frames2, c2, 4);

    // 悬停左侧展开按钮触发悬浮预览
    const openNavPos = await evalInTab(client, () => {
      const r = document.querySelector('button[aria-label="Open navigation menu"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothMove(openNavPos.x, openNavPos.y, frames2, c2, 8);
    for (let i = 0; i < 6; i++) {
      await sleep(75);
      await captureFrame(frames2, c2, 1);
    }
    await waitFor(() => evalInTab(client, () => !!document.querySelector('.nav-content.aip-peek')));
    await captureFrame(frames2, c2, 10);

    // 点击图钉固定左栏
    const leftPinPos = await evalInTab(client, () => {
      const r = document.querySelector('.aip-peek-pin').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothClick(leftPinPos.x, leftPinPos.y, frames2, c2);
    await captureFrame(frames2, c2, 7);

    // 关闭右侧 Run settings
    const closeRightPos = await evalInTab(client, () => {
      const r = document.querySelector('button[aria-label="Close run settings panel"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothClick(closeRightPos.x, closeRightPos.y, frames2, c2);
    await waitFor(() => evalInTab(client, () => !!document.querySelector('.runsettings-toggle-button')));
    await smoothMove(760, 220, frames2, c2, 6);
    await captureFrame(frames2, c2, 4);

    // 悬停右侧调谐按钮触发右侧悬浮预览
    const openRightPos = await evalInTab(client, () => {
      const r = document.querySelector('.runsettings-toggle-button').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothMove(openRightPos.x, openRightPos.y, frames2, c2, 8);
    for (let i = 0; i < 6; i++) {
      await sleep(75);
      await captureFrame(frames2, c2, 1);
    }
    await waitFor(() => evalInTab(client, () => !!document.querySelector('ms-right-side-panel.aip-run-peek')));
    await captureFrame(frames2, c2, 10);

    // 点击图钉固定右栏
    const rightPinPos = await evalInTab(client, () => {
      const r = document.querySelector('.aip-run-pin').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await smoothClick(rightPinPos.x, rightPinPos.y, frames2, c2);
    await captureFrame(frames2, c2, 9);

    encodeGif(frames2, join(ASSETS_DIR, 'demo-peek-dark.gif'), { width: 1200, fps: 12 });
    console.log('已生成全部高清真站脱敏演示文件到 docs/assets/。');
  } finally {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    client.close();
    await closeTempTab(PORT, target.id);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
