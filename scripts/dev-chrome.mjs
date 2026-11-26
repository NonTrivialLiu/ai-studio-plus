#!/usr/bin/env node
/**
 * 启动本机 Chrome for Testing 开发调试实例：
 * - 自动加载未打包扩展 (extension/)
 * - 持久化独立调试档案 (~/.cache/ai-studio-plus/chrome-dev-profile)，保留登录态与 DevTools 偏好
 * - 开启 CDP 远程调试端口 (默认 9222，可用 AIP_DEV_PORT 覆盖)
 *
 * 用法：
 *   npm run dev:chrome              后台启动调试浏览器并打开 chrome://extensions 与 AI Studio
 *   npm run dev:watch               监听 extension/src 与 extension/styles，改动后串行构建并重载
 *   node scripts/dev-chrome.mjs --blank   仅打开空白页与扩展管理页
 */
import { spawn } from 'node:child_process';
import { mkdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, findChromium, reloadExtensionAndTabs, runBuild } from './chromium.mjs';

const EXTENSION_DIR = join(ROOT, 'extension');
const PORT = Number(process.env.AIP_DEV_PORT || 9222);
const PROFILE_DIR = process.env.AIP_DEV_PROFILE || join(homedir(), '.cache', 'ai-studio-plus', 'chrome-dev-profile');
const POLL_MAX_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 200;
const WATCH_DEBOUNCE_MS = 150;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getCdpVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function launchBrowser(watchMode, blankMode) {
  const existing = await getCdpVersion(PORT);
  if (existing) {
    console.log(`调试浏览器已在运行: ${existing.Browser}`);
    console.log(`CDP WebSocket: ${existing.webSocketDebuggerUrl}`);
    return null;
  }

  const executable = findChromium();
  if (!executable) {
    throw new Error('未找到 Chrome for Testing / Chromium，请设置 AIP_DEV_CHROME 指向可执行文件。');
  }
  mkdirSync(PROFILE_DIR, { recursive: true });

  const urls = blankMode ? ['chrome://extensions', 'about:blank'] : ['chrome://extensions', 'https://aistudio.google.com/'];
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(process.env.AIP_DEV_PROXY ? [`--proxy-server=${process.env.AIP_DEV_PROXY}`] : []),
    ...urls
  ];

  const child = spawn(executable, args, {
    detached: !watchMode,
    stdio: 'ignore'
  });
  if (!watchMode) child.unref();

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const info = await getCdpVersion(PORT);
    if (info) {
      console.log(`已启动调试浏览器: ${info.Browser}`);
      console.log(`扩展目录: ${EXTENSION_DIR}`);
      console.log(`调试档案: ${PROFILE_DIR}`);
      console.log(`CDP 地址: http://127.0.0.1:${PORT}`);
      console.log(`CDP WebSocket: ${info.webSocketDebuggerUrl}`);
      return child;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`等待 CDP 端口 ${PORT} 超时`);
}

function startWatch() {
  let timer = null;
  let inFlight = false;
  let rerunPending = false;
  const dirs = [join(EXTENSION_DIR, 'src'), join(EXTENSION_DIR, 'styles')];

  const flush = async () => {
    if (inFlight) {
      rerunPending = true;
      return;
    }
    inFlight = true;
    try {
      do {
        rerunPending = false;
        runBuild();
        const { extensionReloaded, tabsReloaded } = await reloadExtensionAndTabs(PORT);
        console.log(`[watch] 已重新构建 (扩展重载: ${extensionReloaded ? '是' : '否'}, 刷新标签页: ${tabsReloaded})`);
      } while (rerunPending);
    } catch (err) {
      console.error('[watch] 刷新失败:', err.message);
    } finally {
      inFlight = false;
    }
  };

  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  };
  for (const dir of dirs) watch(dir, { recursive: true }, trigger);
  console.log('[watch] 正在监听 extension/src 与 extension/styles 改动...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const watchMode = process.argv.includes('--watch');
  const blankMode = process.argv.includes('--blank');

  runBuild();
  await launchBrowser(watchMode, blankMode);
  if (watchMode) startWatch();
}
