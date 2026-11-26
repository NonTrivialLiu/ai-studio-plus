/**
 * 共享 Chromium 发现与 CDP 调试客户端辅助：供开发脚本与浏览器测试共用。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 运行聚合构建脚本，确保 extension/ 产物最新。 */
export function runBuild() {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
}

/** 判断 URL 是否属于 Google AI Studio 主站或国内镜像。 */
export function isAiStudioUrl(url) {
  return typeof url === 'string' && (url.includes('aistudio.google.com') || url.includes('aistudio.google.cn'));
}

/** 查找本机支持加载未打包扩展的 Chrome for Testing / Chromium。 */
export function findChromium() {
  const explicit = process.env.AIP_DEV_CHROME || process.env.AIP_TEST_CHROME;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`指定的 Chromium 可执行文件不存在：${explicit}`);
    return explicit;
  }
  const home = process.env.HOME;
  const patterns = [
    `${home}/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${home}/Library/Caches/ms-playwright/chromium-*/chrome-linux*/chrome`,
    `${home}/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`,
    `${home}/.cache/puppeteer/chrome/*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${home}/.cache/puppeteer/chrome/*/chrome-linux*/chrome`,
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  const found = patterns.flatMap(pattern => globSync(pattern)).filter(existsSync);
  if (!found.length && process.env.AIP_REQUIRE_BROWSER === '1') {
    throw new Error('未找到用于扩展测试的 Chromium');
  }
  if (!found.length) return null;
  found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return found[found.length - 1];
}

/** 创建带超时与断线拒绝保护的持久 CDP WebSocket 客户端。 */
export function connectWs(wsUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    let opened = false;
    const pending = new Map();
    const listeners = new Set();

    const failAll = err => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
    };

    const connectTimer = setTimeout(() => {
      if (!opened) {
        ws.close();
        reject(new Error(`CDP WebSocket 连接超时 (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    ws.addEventListener('open', () => {
      opened = true;
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}, cmdTimeoutMs = timeoutMs) {
          const id = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP 命令超时: ${method} (${cmdTimeoutMs}ms)`));
            }, cmdTimeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        onEvent(fn) { listeners.add(fn); },
        close() {
          clearTimeout(connectTimer);
          failAll(new Error('CDP 连接已关闭'));
          ws.close();
        }
      });
    });

    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(`${msg.error.message}`));
        else entry.resolve(msg.result);
        return;
      }
      for (const fn of listeners) fn(msg);
    });

    ws.addEventListener('error', () => {
      clearTimeout(connectTimer);
      const err = new Error('CDP WebSocket 连接错误');
      if (!opened) reject(err);
      failAll(err);
    });

    ws.addEventListener('close', () => {
      clearTimeout(connectTimer);
      const err = new Error('CDP WebSocket 连接已断开');
      if (!opened) reject(err);
      failAll(err);
    });
  });
}

/** 发送单次 CDP 命令并自动关闭连接。 */
export async function sendCdp(wsUrl, method, params = {}, timeoutMs = 15000) {
  const client = await connectWs(wsUrl, timeoutMs);
  try {
    return await client.send(method, params, timeoutMs);
  } finally {
    client.close();
  }
}

/** 在 chrome://extensions 页面上下文执行表达式（未打开时按需临时打开并在结束后关闭）。 */
export async function withExtensionsPage(port, expression) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  let extPage = targets.find(t => t.type === 'page' && t.url.startsWith('chrome://extensions'));
  let createdId = null;
  if (!extPage) {
    extPage = await fetch(`http://127.0.0.1:${port}/json/new?chrome://extensions`, { method: 'PUT' }).then(r => r.json());
    createdId = extPage.id;
  }
  try {
    const res = await sendCdp(extPage.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    return res?.result?.value;
  } finally {
    if (createdId) await fetch(`http://127.0.0.1:${port}/json/close/${createdId}`).catch(() => {});
  }
}

/** 在调试浏览器中读取 AI Studio Plus 扩展信息。 */
export function getInstalledExtensionInfo(port) {
  return withExtensionsPage(port, `
    (async () => {
      if (!chrome?.developerPrivate) return [];
      const items = await chrome.developerPrivate.getExtensionsInfo();
      return items
        .filter(i => i.name === 'AI Studio Plus' || i.path?.endsWith('/extension'))
        .map(i => ({ id: i.id, name: i.name, version: i.version, state: i.state, path: i.path }));
    })()
  `);
}

/** 通过 CDP 重载 AI Studio Plus 扩展并刷新所有已打开的 AI Studio 标签页。 */
export async function reloadExtensionAndTabs(port) {
  const result = await withExtensionsPage(port, `
    (async () => {
      if (!chrome?.developerPrivate) return 'no-developerPrivate';
      const items = await chrome.developerPrivate.getExtensionsInfo();
      const target = items.find(i => i.name === 'AI Studio Plus' || i.path?.endsWith('/extension'));
      if (!target) return 'not-found';
      await chrome.developerPrivate.reload(target.id, { failQuietly: true });
      return 'reloaded:' + target.id;
    })()
  `);
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
  const studioTabs = targets.filter(t => t.type === 'page' && isAiStudioUrl(t.url));
  for (const tab of studioTabs) {
    if (tab.webSocketDebuggerUrl) await sendCdp(tab.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: false });
  }
  return { extensionReloaded: String(result).startsWith('reloaded:'), detail: result, tabsReloaded: studioTabs.length };
}
