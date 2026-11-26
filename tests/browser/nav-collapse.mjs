import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Browser, createSuite, findChromium } from './cdp.mjs';
import { ROOT } from '../unit/harness.mjs';

const FIXTURE_MATCH = 'http://127.0.0.1/*';

const html = `<!doctype html><style>
  html,body { margin:0;height:100% } ms-app { display:flex;height:100% }
  ms-navbar-v2 { display:block;flex:none } .nav-content { box-sizing:border-box;width:240px;height:100%;padding:0 8px;display:flex;flex-direction:column }
  .nav-content.collapsed { width:0.75px;visibility:hidden;padding:0 } main { flex:1; position:relative }
  .aip-history-scroll { height:160px;overflow:auto;overscroll-behavior:contain }
  .history-rows { height:2000px }
  .floating-toggle-button { position:fixed;left:16px;top:16px;width:32px;height:32px }
  .token-container { position:absolute;left:170px;top:0;width:100px;height:48px;margin:0;cursor:help }
  ms-playground-toolbar { position:absolute;top:0;left:0;z-index:1001 }
  ms-token-count [role=tooltip] { display:none }
  .token-container:hover [role=tooltip] { display:block }
  .nav-content.collapsed .aip-history { display:none }
  @media (max-width: 900px) { .nav-content { position:fixed; inset:0 auto 0 0 } }
</style><ms-app class="makersuite-layout"><ms-navbar-v2><div class="nav-content expanded">
  <div class="navbar-header"><button aria-label="Collapse navigation menu">Collapse</button></div><div class="aip-history"><div class="aip-history-scroll"><div class="history-rows"><a href="#">Chat</a><input></div></div></div>
</div></ms-navbar-v2><main class="layout-wrapper"><button class="floating-toggle-button" aria-label="Open navigation menu" hidden>Open</button>Content
<ms-playground-toolbar><p class="token-container"><ms-token-count>Tokens<span role="tooltip">Token Usage</span></ms-token-count></p></ms-playground-toolbar>
</main></ms-app>
<script>
  const content=document.querySelector('.nav-content'); const open=document.querySelector('.floating-toggle-button');
  function setOpen(value){content.classList.toggle('expanded',value);content.classList.toggle('collapsed',!value);content.inert=!value;open.hidden=value}
  document.querySelector('[aria-label="Collapse navigation menu"]').onclick=()=>setOpen(false);open.onclick=()=>setOpen(true);
</script>`;

function stageRealExtension() {
  const root = mkdtempSync(join(tmpdir(), 'aip-nav-test-'));
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
    console.log('没有找到能加载未打包扩展的 Chromium，跳过导航悬浮测试。可用 AIP_TEST_CHROME 指定可执行文件。');
    return true;
  }
  const staged = stageRealExtension();
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const suite = createSuite('导航悬浮测试');
  let browser;
  try {
    browser = await Browser.launch({ executable, extensionDir: staged.extDir });
    const tab = await browser.newTab();
    await tab.goto(origin);
    const move = (x, y, extra = {}) => browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, ...extra }, tab.sessionId);
    const click = async (x, y) => {
      await move(x, y);
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, tab.sessionId);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, tab.sessionId);
    };
    const KEY_CODES = { b: 66, Escape: 27 };
    const key = async (keyName, code, modifiers = 0) => {
      const vk = KEY_CODES[keyName] || keyName.toUpperCase().charCodeAt(0);
      const type = keyName.length === 1 ? 'keyDown' : 'rawKeyDown';
      await browser.send('Input.dispatchKeyEvent', { type, key: keyName, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, tab.sessionId);
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, tab.sessionId);
    };
    const peek = () => tab.evaluate(() => document.querySelector('.nav-content').classList.contains('aip-peek'));

    await suite.test('折叠时悬浮预览覆盖内容，移开后收起', async () => {
      await tab.evaluate(() => document.querySelector('[aria-label="Collapse navigation menu"]').click());
      const before = await tab.evaluate(() => document.querySelector('main').getBoundingClientRect().width);
      await move(600, 300);
      await move(25, 25);
      await tab.waitFor(peek, { message: '悬浮展开' });
      assert.equal(await tab.evaluate(() => document.querySelector('main').getBoundingClientRect().width), before);
      assert.equal(await tab.evaluate(() => Math.round(document.querySelector('.nav-content').getBoundingClientRect().width)), 240);
      const input = await tab.evaluate(() => {
        const r = document.querySelector('.aip-history input').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await click(input.x, input.y);
      assert.equal(await tab.evaluate(() => document.activeElement.matches('.aip-history input')), true);
      await move(60, 80);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 60, y: 80, deltaX: 0, deltaY: 120 }, tab.sessionId);
      await tab.waitFor(() => tab.evaluate(() => document.querySelector('.aip-history-scroll').scrollTop > 0), { message: '悬浮历史列表响应真实滚轮' });
      await move(700, 400);
      await tab.waitFor(async () => !(await peek()), { message: '离开收起' });
      assert.equal(await tab.evaluate(() => document.querySelector('.nav-content').inert), true);
    });

    await suite.test('按住鼠标拖拽移出时不收起预览', async () => {
      await move(25, 25);
      await tab.waitFor(peek, { message: '悬浮展开' });
      await move(700, 400, { buttons: 1 });
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(await peek(), true, '按住鼠标拖拽移出时不收起预览');
      await move(700, 400);
      await tab.waitFor(async () => !(await peek()), { message: '松开后移出收起' });
    });

    await suite.test('原生覆盖布局里左栏不悬浮，点击仍展开', async () => {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
      await move(25, 25);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(await peek(), false);
      await click(25, 25);
      await tab.waitFor(() => tab.evaluate(() => document.querySelector('.nav-content').classList.contains('expanded')));
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
      await tab.evaluate(() => document.querySelector('[aria-label="Collapse navigation menu"]').click());
      await move(600, 300);
    });

    await suite.test('多选或菜单开启时保持预览，结束后收起', async () => {
      await move(25, 25);
      await tab.waitFor(peek);
      await tab.evaluate(() => document.querySelector('.aip-history').classList.add('is-selecting'));
      await move(700, 400);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(await peek(), true);
      await tab.evaluate(() => document.querySelector('.aip-history').classList.remove('is-selecting'));
      await click(700, 400);
      await tab.waitFor(async () => !(await peek()));
    });

    await suite.test('固定按钮不被 Token Usage 抢占，固定后恢复提示', async () => {
      await move(25, 25);
      await tab.waitFor(peek);
      const rect = await tab.evaluate(() => { const r = document.querySelector('.aip-peek-pin').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await move(rect.x, rect.y);
      assert.equal(await tab.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.aip-peek-pin'), rect), true);
      assert.equal(await tab.evaluate(() => document.querySelector('[role=tooltip]').checkVisibility({ visibilityProperty: true })), false);
      await click(rect.x, rect.y);
      await tab.waitFor(async () => await tab.evaluate(() => document.querySelector('.nav-content').classList.contains('expanded')));
      assert.equal(await peek(), false);
      assert.equal(await tab.evaluate(() => document.querySelector('.nav-content').inert), false);
      await move(440, 20);
      assert.equal(await tab.evaluate(() => document.querySelector('[role=tooltip]').checkVisibility({ visibilityProperty: true })), true);
      await move(700, 400);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(await tab.evaluate(() => document.querySelector('.nav-content').classList.contains('expanded')), true);
    });

    await suite.test('Mod+B 切换；输入框与选择模式不拦截', async () => {
      const modifiers = await tab.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 4 : 2);
      await tab.evaluate(() => document.activeElement.blur());
      await key('b', 'KeyB', modifiers);
      await tab.waitFor(async () => await tab.evaluate(() => document.querySelector('.nav-content').classList.contains('collapsed')));
      await move(700, 400);
      await key('b', 'KeyB', modifiers);
      await tab.waitFor(async () => await tab.evaluate(() => document.querySelector('.nav-content').classList.contains('expanded')));
      await tab.evaluate(() => document.querySelector('input').focus());
      await key('b', 'KeyB', modifiers);
      assert.equal(await tab.evaluate(() => document.querySelector('.nav-content').classList.contains('expanded')), true);
      await tab.evaluate(() => { document.activeElement.blur(); document.querySelector('.aip-history').classList.add('is-selecting'); });
      await key('b', 'KeyB', modifiers);
      assert.equal(await tab.evaluate(() => document.querySelector('.nav-content').classList.contains('expanded')), true);
      await tab.evaluate(() => document.querySelector('.aip-history').classList.remove('is-selecting'));
    });

    await suite.test('Escape 关闭左栏预览并把焦点交给打开按钮', async () => {
      await tab.evaluate(() => document.querySelector('[aria-label="Collapse navigation menu"]').click());
      await move(600, 300);
      await move(25, 25);
      await tab.waitFor(peek, { message: '悬浮展开' });
      await key('Escape', 'Escape');
      await tab.waitFor(async () => !(await peek()), { message: 'Escape 关闭预览' });
      assert.equal(await tab.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Open navigation menu');
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
