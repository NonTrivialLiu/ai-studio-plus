#!/usr/bin/env node
/**
 * 打包发布归档：先执行构建，再按 extension/manifest.json 声明清单生成并校验 build/AI-Studio-Plus-WebExtension.zip。
 */
import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from './chromium.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'extension');
const output = join(root, 'build');

function collectManifestFiles(manifest) {
  const files = new Set(['manifest.json']);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) files.add(file);
    for (const file of script.css || []) files.add(file);
  }
  for (const res of manifest.web_accessible_resources || []) {
    for (const file of res.resources || []) files.add(file);
  }
  for (const file of Object.values(manifest.icons || {})) files.add(file);
  if (manifest.default_locale) {
    for (const file of globSync('_locales/*/messages.json', { cwd: extensionDir }).sort()) {
      files.add(file);
    }
  }
  return Array.from(files);
}

runBuild();
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
const files = collectManifestFiles(manifest);

mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(output, '.package-'));
try {
  const archive = join(temp, 'extension.zip');
  execFileSync('zip', ['-q', archive, ...files], { cwd: extensionDir, stdio: 'inherit' });
  execFileSync('unzip', ['-tq', archive], { stdio: 'inherit' });
  const listed = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const expected = new Set(files);
  const unexpected = listed.filter(name => !expected.has(name));
  const missing = files.filter(name => !listed.includes(name));
  if (unexpected.length || missing.length) {
    throw new Error(`压缩包内容校验失败：多余 [${unexpected.join(', ')}]，缺失 [${missing.join(', ')}]`);
  }
  const dest = join(output, 'AI-Studio-Plus-WebExtension.zip');
  renameSync(archive, dest);
  console.log(`已生成并校验 ${dest} (${listed.length} 个文件)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
