#!/usr/bin/env node
/**
 * 零依赖静态与架构门禁 (pure Node >=22)：
 * 校验语法与 JSON、Trusted Types 禁忌 API、构建产物一致性、清单/版本同步、模块体积与命名空间、CSS 变量卫生。
 */
import { execFile } from 'node:child_process';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { BUNDLES, buildBundle } from './build.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'extension');
const MAX_SOURCE_LINES = 500;
const FORBIDDEN_TT_PATTERNS = [
  { name: '.innerHTML', regex: /\.innerHTML\b/ },
  { name: '.outerHTML', regex: /\.outerHTML\b/ },
  { name: '.insertAdjacentHTML', regex: /\.insertAdjacentHTML\s*\(/ },
  { name: 'document.write', regex: /\bdocument\.write(?:ln)?\s*\(/ },
  { name: 'eval()', regex: /\beval\s*\(/ },
  { name: 'new Function', regex: /\bnew\s+Function\b/ }
];
const FORBIDDEN_CHROME_APIS = /\bchrome\.(storage|tabs|cookies|scripting|webRequest|bookmarks|history|downloads)\b/;
const MACHINE_PATH_PATTERN = /(?:\/Users\/|\/Volumes\/|[A-Za-z]:\\\\)/;

const errors = [];
const fail = (file, msg) => errors.push(`${file}: ${msg}`);

/** 将注释与字符串字面量替换为空格占位（保留换行），用于精确扫描代码标识符。 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < len && source[i] !== '\n') { out += ' '; i++; }
    } else if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < len) { out += '  '; i += 2; }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < len && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < len) {
          out += source[i + 1] === '\n' ? '\n' : '  ';
          i += 2;
        } else {
          out += source[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      if (i < len) { out += ' '; i++; }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function hasDocblockHeader(source) {
  const withoutShebang = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;
  return withoutShebang.trimStart().startsWith('/**');
}

function checkJsonFiles() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'));
  if (pkg.version !== manifest.version) {
    fail('extension/manifest.json', `version (${manifest.version}) 与 package.json (${pkg.version}) 不一致，请同步两者。`);
  }
  const expectedFiles = new Set();
  for (const cs of manifest.content_scripts || []) {
    for (const f of [...(cs.js || []), ...(cs.css || [])]) expectedFiles.add(f);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const f of war.resources || []) expectedFiles.add(f);
  }
  for (const file of expectedFiles) {
    if (!existsSync(join(EXTENSION, file))) {
      fail('extension/manifest.json', `声明的资源不存在：extension/${file}，请先运行 npm run build。`);
    }
  }
  const csMatches = manifest.content_scripts?.[0]?.matches || [];
  const warMatches = manifest.web_accessible_resources?.[0]?.matches || [];
  if (JSON.stringify(csMatches) !== JSON.stringify(warMatches)) {
    fail('extension/manifest.json', 'content_scripts[0].matches 与 web_accessible_resources[0].matches 不一致。');
  }
}

function checkBundles() {
  const declared = new Set();
  for (const bundle of BUNDLES) {
    for (const src of bundle.sources) {
      declared.add(src);
      if (!existsSync(join(EXTENSION, src))) {
        fail('scripts/build.mjs', `声明的源文件不存在：extension/${src}`);
      }
    }
    const built = buildBundle(bundle);
    const actualPath = join(EXTENSION, bundle.target);
    const actual = existsSync(actualPath) ? readFileSync(actualPath, 'utf8') : null;
    if (actual !== built) {
      fail(`extension/${bundle.target}`, '产物与源码不一致，请运行 npm run build 重新生成。');
    }
  }
  for (const file of [...globSync('src/*.js', { cwd: EXTENSION }), ...globSync('styles/*.css', { cwd: EXTENSION })]) {
    if (!declared.has(file)) {
      fail(`extension/${file}`, '未列入 scripts/build.mjs 的 BUNDLES 中，不会被打包。');
    }
  }
}

function checkExtensionSources() {
  const files = globSync('extension/src/*.js', { cwd: ROOT }).sort();
  const setProperties = new Set();
  for (const rel of files) {
    const abs = join(ROOT, rel);
    const raw = readFileSync(abs, 'utf8');
    const code = stripCommentsAndStrings(raw);
    const lines = raw.split(/\r?\n/);

    try {
      new vm.Script(raw, { filename: rel });
    } catch (err) {
      fail(rel, `语法错误：${err.message}`);
    }

    if (!hasDocblockHeader(raw)) {
      fail(rel, '文件顶部缺少 /** ... */ 模块说明头注释。');
    }
    if (lines.length > MAX_SOURCE_LINES) {
      fail(rel, `文件共 ${lines.length} 行，超过 ${MAX_SOURCE_LINES} 行上限，请按职责拆分模块。`);
    }
    if (/\b(?:import|export)\s+/.test(code)) {
      fail(rel, '经典内容脚本禁止使用 ESM import/export（由 scripts/build.mjs 拼接）。');
    }
    if (/\bconsole\.log\s*\(|\bdebugger\b/.test(code)) {
      fail(rel, '禁止残留 console.log 或 debugger。');
    }
    for (const rule of FORBIDDEN_TT_PATTERNS) {
      if (rule.regex.test(code)) {
        fail(rel, `禁止使用 ${rule.name}（站点启用了 Trusted Types，请使用 DOM API）。`);
      }
    }
    if (/\b(?:setTimeout|setInterval)\s*\(\s*['"`]/.test(raw)) {
      fail(rel, '禁止向 setTimeout/setInterval 传入字符串参数。');
    }
    if (FORBIDDEN_CHROME_APIS.test(code)) {
      fail(rel, '禁止调用未在 manifest.json 声明权限的 chrome.* API。');
    }
    if (/\bwindow\.AIP\w*/.test(code)) {
      fail(rel, '请统一使用 globalThis.AIP* 代替 window.AIP*。');
    }
    if (/(?<!\.)\bAIPSidebarSpace\b/.test(code)) {
      fail(rel, '请使用 globalThis.AIPSidebarSpace 代替裸全局引用 AIPSidebarSpace。');
    }
    lines.forEach((line, idx) => {
      if (/\.src\s*=/.test(line) && !line.includes('aip-lint-allow: trusted-script-fallback')) {
        fail(`${rel}:${idx + 1}`, '赋值 .src 需谨慎处理 TrustedScriptURL，若确为兜底注入请加 aip-lint-allow 注释。');
      }
      if (MACHINE_PATH_PATTERN.test(line)) {
        fail(`${rel}:${idx + 1}`, '禁止在源码或注释中硬编码本机绝对路径。');
      }
    });
    for (const match of raw.matchAll(/setProperty\(\s*['"](--aip-[a-z0-9-]+)['"]/g)) {
      setProperties.add(match[1]);
    }
  }
  return setProperties;
}

function checkExtensionCss(jsDeclaredVars) {
  const files = globSync('extension/styles/*.css', { cwd: ROOT }).sort();
  const declaredVars = new Set(jsDeclaredVars);
  const usedVars = [];

  for (const rel of files) {
    const raw = readFileSync(join(ROOT, rel), 'utf8');
    let depth = 0;
    for (const ch of raw) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) break;
    }
    if (depth !== 0) fail(rel, 'CSS 大括号 { } 不匹配。');
    if (/@import\b/i.test(raw) || /url\(\s*['"]?https?:/i.test(raw)) {
      fail(rel, 'MV3 零网络扩展样式禁止使用 @import 或远程 url(http...)。');
    }
    if (MACHINE_PATH_PATTERN.test(raw)) {
      fail(rel, '禁止在样式中硬编码本机绝对路径。');
    }
    for (const m of raw.matchAll(/(--aip-[a-z0-9-]+)\s*:/g)) {
      declaredVars.add(m[1]);
    }
    for (const m of raw.matchAll(/var\(\s*(--aip-[a-z0-9-]+)\b/g)) {
      usedVars.push({ file: rel, name: m[1] });
    }
  }

  for (const { file, name } of usedVars) {
    if (!declaredVars.has(name)) {
      fail(file, `引用了未定义的 CSS 自定义属性 ${name}（既未在 CSS 中声明，也未通过 JS setProperty 设置）。`);
    }
  }
}

async function checkScriptsAndTests() {
  const mjsFiles = [
    ...globSync('scripts/*.mjs', { cwd: ROOT }),
    ...globSync('tests/**/*.mjs', { cwd: ROOT })
  ].sort();

  await Promise.all(mjsFiles.map(async rel => {
    const abs = join(ROOT, rel);
    const raw = readFileSync(abs, 'utf8');
    if (rel.startsWith('scripts/')) {
      if (!hasDocblockHeader(raw)) fail(rel, '脚本顶部缺少 /** ... */ 说明头注释。');
      if (/from\s+['"]\.\.\/tests\//.test(raw)) {
        fail(rel, 'scripts/ 禁止反向依赖 tests/，共享辅助应放在 scripts/。');
      }
      raw.split(/\r?\n/).forEach((line, idx) => {
        if (MACHINE_PATH_PATTERN.test(line)) {
          fail(`${rel}:${idx + 1}`, '禁止硬编码本机绝对路径，请使用相对路径或 path.join(ROOT, ...)。');
        }
      });
    }
    try {
      await execFileAsync(process.execPath, ['--check', abs]);
    } catch (err) {
      fail(rel, `语法检查失败：${err.stderr || err.message}`);
    }
  }));

  for (const rel of globSync('extension/*.js', { cwd: ROOT })) {
    try {
      new vm.Script(readFileSync(join(ROOT, rel), 'utf8'), { filename: rel });
    } catch (err) {
      fail(rel, `打包产物语法错误：${err.message}`);
    }
  }
}

checkJsonFiles();
checkBundles();
const jsVars = checkExtensionSources();
checkExtensionCss(jsVars);
await checkScriptsAndTests();

if (errors.length) {
  console.error(`静态检查发现 ${errors.length} 项问题：\n` + errors.map(e => `  ✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`静态与架构检查通过 (${relative(ROOT, EXTENSION)} 与 scripts/、tests/)`);
