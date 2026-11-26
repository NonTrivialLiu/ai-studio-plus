#!/usr/bin/env node
/**
 * 聚合构建：按 BUNDLES 声明顺序把 extension/src 与 extension/styles 拼成扩展加载产物。
 * 约束：protocol 须最先加载，sidebar-* 子模块须在 sidebar 之前，sidebar-space 须在 nav-collapse 与 run-settings-peek 之前，main 须最后加载。
 * 源码永远在 src/ 与 styles/ 下改；根目录的三个聚合文件是生成物，不要手改。
 *
 *   node scripts/build.mjs            重新生成 (内容没变就不动文件)
 *   node scripts/build.mjs --check    只校验产物与源码是否一致，不一致时退出码为 1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'extension');

export const BUNDLES = [
  { target: 'content.js', sources: ['src/protocol.js', 'src/history-store.js', 'src/sidebar-shared.js', 'src/sidebar-edit.js', 'src/sidebar-selection.js', 'src/sidebar-menu.js', 'src/sidebar.js', 'src/sidebar-space.js', 'src/nav-collapse.js', 'src/run-settings-peek.js', 'src/bubbles.js', 'src/main.js'] },
  { target: 'interceptor.js', sources: ['src/protocol.js', 'src/prompts-parser.js', 'src/interceptor.js'] },
  { target: 'content.css', sources: ['styles/bubbles.css', 'styles/sidebar.css', 'styles/nav-collapse.css', 'styles/run-settings-peek.css', 'styles/performance.css'] }
];

function banner(target) {
  return `/* 由 scripts/build.mjs 生成，请勿手改：修改 extension/src 或 extension/styles 后运行 npm run build。 */\n`
    + `/* ${target} ← ${BUNDLES.find(bundle => bundle.target === target).sources.join(' + ')} */\n`;
}

export function buildBundle(bundle) {
  return banner(bundle.target) + bundle.sources
    .map(source => readFileSync(join(EXTENSION, source), 'utf8').trimEnd())
    .join('\n\n') + '\n';
}

function main() {
  const check = process.argv.includes('--check');
  mkdirSync(EXTENSION, { recursive: true });
  const stale = BUNDLES.filter(bundle => {
    const output = buildBundle(bundle);
    const path = join(EXTENSION, bundle.target);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === output) return false;
    if (!check) writeFileSync(path, output);
    return true;
  });
  if (check && stale.length) {
    console.error('产物与源码不一致，请先运行 npm run build：' + stale.map(bundle => bundle.target).join('、'));
    process.exit(1);
  }
  console.log(check ? `产物与源码一致 (${BUNDLES.length} 个文件)` : `已生成 ${stale.length ? stale.map(bundle => bundle.target).join('、') : '无变化'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
