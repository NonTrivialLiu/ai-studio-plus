#!/usr/bin/env node
/**
 * CDP 实时调试助手：连接本地 Chrome 远程调试端口 (默认 9222，可用 AIP_DEV_PORT 覆盖)。
 *
 * 用法：
 *   node scripts/debug-cdp.mjs status                  查看浏览器版本、扩展状态与打开的标签页
 *   node scripts/debug-cdp.mjs inspect [--url=substr]  在目标页执行 tests/inspect.js 并输出结果
 *   node scripts/debug-cdp.mjs console [--url=substr]  实时输出目标页 console 日志与未捕获异常
 *   node scripts/debug-cdp.mjs reload                  重新构建扩展、重载扩展并刷新 AI Studio 标签页
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, connectWs, getInstalledExtensionInfo, isAiStudioUrl, reloadExtensionAndTabs, runBuild } from './chromium.mjs';

const PORT = Number(process.env.AIP_DEV_PORT || 9222);

async function fetchJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} (${path})`);
  return res.json();
}

function findTarget(targets, urlFilter) {
  const pages = targets.filter(t => t.type === 'page');
  if (urlFilter) return pages.find(t => t.url.includes(urlFilter));
  return pages.find(t => isAiStudioUrl(t.url)) || pages[0];
}

async function cmdStatus() {
  const version = await fetchJson('/json/version');
  const targets = await fetchJson('/json/list');
  const extensions = await getInstalledExtensionInfo(PORT).catch(() => []);
  console.log(`Browser: ${version.Browser}`);
  console.log(`WebSocket: ${version.webSocketDebuggerUrl}`);
  if (extensions.length) {
    for (const ext of extensions) {
      console.log(`Extension: ${ext.name} v${ext.version} [${ext.state}] id=${ext.id} (${ext.path})`);
    }
  } else {
    console.log('Extension: 未检测到 AI Studio Plus');
  }
  console.log('');
  for (const t of targets.filter(x => x.type === 'page')) {
    console.log(`- [${t.id}] ${t.title || '(untitled)'} -> ${t.url}`);
  }
}

async function cmdInspect(urlFilter) {
  const targets = await fetchJson('/json/list');
  const target = findTarget(targets, urlFilter);
  if (!target?.webSocketDebuggerUrl) {
    console.error('未找到可调试的目标标签页');
    process.exit(1);
  }
  if (!urlFilter && target.url.includes('accounts.google.com')) {
    console.error(`当前标签页正在 Google 登录页 (${target.url})，请先登录后再打开 AI Studio 会话页执行 inspect。`);
    process.exit(1);
  }
  console.log(`Target: ${target.url}`);
  const script = readFileSync(join(ROOT, 'tests', 'inspect.js'), 'utf8');
  const client = await connectWs(target.webSocketDebuggerUrl);
  try {
    const res = await client.send('Runtime.evaluate', { expression: script, returnByValue: true });
    if (res.exceptionDetails) {
      console.error('执行 inspect.js 出错:', JSON.stringify(res.exceptionDetails, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(res.result?.value, null, 2));
    if (!res.result?.value?.pass) process.exitCode = 1;
  } finally {
    client.close();
  }
}

async function cmdConsole(urlFilter) {
  const targets = await fetchJson('/json/list');
  const target = findTarget(targets, urlFilter);
  if (!target?.webSocketDebuggerUrl) {
    console.error('未找到可调试的目标标签页');
    process.exit(1);
  }
  console.log(`已连接日志流: ${target.url} (Ctrl+C 退出)\n`);
  const client = await connectWs(target.webSocketDebuggerUrl);
  client.onEvent(msg => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
      console.log(`[console.${msg.params.type}] ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params.exceptionDetails;
      console.error(`[exception] ${ex.text} ${ex.exception?.description || ''}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      console.log(`[log.${e.level}] ${e.text}`);
    }
  });
  await client.send('Runtime.enable');
  await client.send('Log.enable');
}

async function cmdReload() {
  runBuild();
  const { extensionReloaded, detail, tabsReloaded } = await reloadExtensionAndTabs(PORT);
  console.log(`扩展重载: ${extensionReloaded ? '成功' : `跳过 (${detail})`}，已刷新 ${tabsReloaded} 个 AI Studio 标签页`);
}

const args = process.argv.slice(2);
const cmd = args.find(a => !a.startsWith('--')) || 'status';
const urlArg = args.find(a => a.startsWith('--url='))?.slice(6);

if (cmd === 'status') await cmdStatus();
else if (cmd === 'inspect') await cmdInspect(urlArg);
else if (cmd === 'console') await cmdConsole(urlArg);
else if (cmd === 'reload') await cmdReload();
else {
  console.error(`未知命令: ${cmd}`);
  process.exit(1);
}
