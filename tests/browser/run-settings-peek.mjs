import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Browser, createSuite, findChromium } from './cdp.mjs';
import { ROOT } from '../unit/harness.mjs';

const FIXTURE_MATCH = 'http://127.0.0.1/*';

const html = `<!doctype html><style>
html,body{margin:0;height:100%}body{display:flex}main{flex:1}
ms-right-side-panel{display:flex;width:0}ms-right-side-panel:has(ms-run-settings){width:300px}
ms-run-settings{display:block;width:300px;height:100vh}.right{display:flex;justify-content:flex-end}
.runsettings-toggle-button{position:fixed;right:12px;top:12px;width:32px;height:32px}
@media (max-width:900px){ms-right-side-panel{position:fixed;right:0}}
</style><main>Main</main><button class="runsettings-toggle-button" aria-label="Toggle run settings panel">Open</button>
<ms-right-side-panel></ms-right-side-panel><script>
const host=document.querySelector('ms-right-side-panel'),open=document.querySelector('.runsettings-toggle-button');
open.onclick=()=>{open.hidden=true;host.innerHTML='<div class="content-container"><ms-run-settings><div class="overlay-header"><div class="right"><button aria-label="Close run settings panel">Close</button></div></div><input aria-label="Setting"></ms-run-settings></div>';host.querySelector('button').onclick=()=>{setTimeout(()=>{host.replaceChildren();open.hidden=false},300)}};
</script>`;

function stageRealExtension() {
  const root = mkdtempSync(join(tmpdir(), 'aip-run-test-'));
  const extDir = join(root, 'extension');
  cpSync(join(ROOT, 'extension'), extDir, { recursive: true });
  const manifestPath = join(extDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const script of manifest.content_scripts) script.matches.push(FIXTURE_MATCH);
  manifest.web_accessible_resources[0].matches.push(FIXTURE_MATCH);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, extDir };
}

async function main() {
  const executable = findChromium();
  if (!executable) {
    console.log('没有找到能加载未打包扩展的 Chromium，跳过右栏测试。可用 AIP_TEST_CHROME 指定可执行文件。');
    return true;
  }
  const staged = stageRealExtension();
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const suite = createSuite('右栏悬浮测试');
  let browser;
  try {
    browser = await Browser.launch({ executable, extensionDir: staged.extDir });
    const tab = await browser.newTab();
    await tab.goto(`http://127.0.0.1:${server.address().port}`);
    const move = (x, y, extra = {}) => browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, ...extra }, tab.sessionId);
    const click = async (x, y) => { await move(x, y); for (const type of ['mousePressed', 'mouseReleased']) await browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, tab.sessionId); };
    const pressEscape = async () => {
      const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, tab.sessionId);
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab.sessionId);
    };
    const state = () => tab.evaluate(() => ({ preview: !!document.querySelector('.aip-run-peek'), panel: !!document.querySelector('ms-run-settings'), pin: !!document.querySelector('.aip-run-pin'), closeVisible: !!document.querySelector('ms-run-settings button[aria-label="Close run settings panel"]')?.getBoundingClientRect().width, main: document.querySelector('main').getBoundingClientRect().width }));

    await suite.test('悬浮预览不改变正文宽度，移开后关闭', async () => {
      const before = await state();
      await move(1260, 24);
      await tab.waitFor(async () => (await state()).pin);
      const preview = await state();
      assert.equal(preview.preview, true);
      assert.equal(preview.closeVisible, false);
      assert.equal(preview.main, before.main);
      await move(600, 400);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal((await state()).main, before.main);
      await tab.waitFor(async () => !(await state()).panel);
      assert.equal((await state()).main, before.main);
    });

    await suite.test('按住鼠标拖拽移出时不关闭预览', async () => {
      await move(1260, 24);
      await tab.waitFor(async () => (await state()).pin);
      await move(600, 400, { buttons: 1 });
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal((await state()).preview, true, '按住鼠标拖拽移出时不关闭预览');
      assert.equal((await state()).panel, true);
      await move(600, 400);
      await tab.waitFor(async () => !(await state()).panel, { message: '松开后移出关闭预览' });
    });

    await suite.test('原生覆盖布局里右栏不悬浮，点击仍展开', async () => {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
      await move(770, 24);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal((await state()).panel, false);
      await click(770, 24);
      await tab.waitFor(async () => (await state()).closeVisible);
      assert.equal((await state()).preview, false);
      await tab.evaluate(() => document.querySelector('ms-run-settings button').click());
      await tab.waitFor(async () => !(await state()).panel);
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
      await move(600, 400);
    });

    await suite.test('左栏占用空间后，剩余宽度不足就不自动展开右栏', async () => {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 920, height: 700, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
      await tab.evaluate(() => {
        const nav = document.createElement('ms-navbar-v2');
        nav.innerHTML = '<div class="nav-content expanded" style="width:240px"></div>';
        document.body.prepend(nav);
      });
      await move(890, 24);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal((await state()).panel, false);
      await tab.evaluate(() => document.querySelector('ms-navbar-v2').remove());
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
      await move(600, 400);
    });

    await suite.test('悬浮时固定，原生关闭按钮恢复', async () => {
      await move(1260, 24);
      await tab.waitFor(async () => (await state()).pin);
      const p = await tab.evaluate(() => { const r = document.querySelector('.aip-run-pin').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await click(p.x, p.y);
      await tab.waitFor(async () => !(await state()).preview);
      assert.equal((await state()).closeVisible, true);
      await move(600, 400);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal((await state()).panel, true, '固定后移开鼠标超过关闭延迟仍保持展开');
      await tab.evaluate(() => document.querySelector('ms-run-settings button[aria-label="Close run settings panel"]').click());
      await tab.waitFor(async () => !(await state()).panel);
    });

    await suite.test('Escape 关闭右栏预览', async () => {
      await move(1260, 24);
      await tab.waitFor(async () => (await state()).pin);
      await pressEscape();
      await tab.waitFor(async () => !(await state()).panel, { message: 'Escape 关闭右栏预览' });
    });

    await tab.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(staged.root, { recursive: true, force: true });
  }
  return suite.summary();
}

process.exit((await main()) ? 0 : 1);
