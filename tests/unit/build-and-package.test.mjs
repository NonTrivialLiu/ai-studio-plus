import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';

test('scripts/build.mjs --check 与 scripts/lint.mjs 在仓库上均通过', () => {
  const buildCheck = execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(buildCheck, /产物与源码一致/);

  const lintOut = execFileSync(process.execPath, [join(ROOT, 'scripts', 'lint.mjs')], { encoding: 'utf8' });
  assert.match(lintOut, /静态与架构检查通过/);
});

test('extension/manifest.json 与 package.json 版本同步', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
});

test('scripts/package.mjs 生成有效归档且仅包含 manifest.json 声明文件，无 src/styles 泄漏', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'package.mjs')], { cwd: ROOT, stdio: 'pipe' });
  const zipPath = join(ROOT, 'build', 'AI-Studio-Plus-WebExtension.zip');
  execFileSync('unzip', ['-tq', zipPath], { stdio: 'pipe' });

  const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .sort();

  const manifest = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  const expected = new Set(['manifest.json']);
  for (const cs of manifest.content_scripts || []) {
    for (const file of [...(cs.js || []), ...(cs.css || [])]) expected.add(file);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const file of war.resources || []) expected.add(file);
  }
  for (const file of Object.values(manifest.icons || {})) expected.add(file);
  if (manifest.default_locale) {
    for (const file of globSync('_locales/*/messages.json', { cwd: join(ROOT, 'extension') })) expected.add(file);
  }

  assert.deepStrictEqual(entries, Array.from(expected).sort());
  for (const icon of ['icons/icon-16.png', 'icons/icon-48.png', 'icons/icon-128.png']) {
    assert.ok(entries.includes(icon), `归档必须包含图标 ${icon}`);
  }
  for (const locale of ['_locales/en/messages.json', '_locales/zh_CN/messages.json']) {
    assert.ok(entries.includes(locale), `归档必须包含多语言清单 ${locale}`);
  }
  assert.equal(entries.some(name => name.startsWith('src/') || name.startsWith('styles/')), false, '归档不得包含 src/ 或 styles/');
});
