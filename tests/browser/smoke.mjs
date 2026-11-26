/**
 * 新侧栏 (行级交互版) 的冒烟测试：用本机的 Chromium 真正加载扩展，访问本地仿真站点，
 * 只从外部观察点验证行为 (DOM、地址栏、焦点、仿真服务器收到的请求)。不读取扩展内部状态。
 * 覆盖：挂载与对齐、抽屉、单击 / 双击 / F2 原位重命名 (Enter / Esc / 空白 / 失败重试)、
 * 三点菜单，以及长按多选、批量删除和失败处理。更多集成用例见 run.mjs。
 *
 *   node tests/browser/smoke.mjs        可用环境变量 AIP_TEST_CHROME 指定 Chromium / Chrome for Testing
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, createSuite, findChromium } from './cdp.mjs';
import { startFixture } from './server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_MATCH = 'http://127.0.0.1/*';
const LINK_BLUE = 'rgb(36, 131, 226)';

// ---- 页面内的观察点：每个函数都会被序列化后送进页面执行，必须自包含 ---------------------------------

const PAGE = {
  count: () => document.querySelectorAll('#aip-history .aip-row').length,
  rect: selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left, y: box.top, right: box.right, bottom: box.bottom, w: box.width, h: box.height };
  },
  rows: () => Array.from(document.querySelectorAll('#aip-history .aip-row')).map(row => ({
    id: row.dataset.id,
    title: row.querySelector('.aip-row-title').textContent,
    current: row.querySelector('a').getAttribute('aria-current')
  })),
  layout: () => {
    const q = selector => document.querySelector(selector);
    const edit = q('.aip-row.is-editing');
    const input = q('.aip-row-edit');
    const menu = q('.aip-menu');
    const handle = q('.aip-drawer');
    return {
      path: location.pathname,
      marker: window.__smokeMarker,
      history: history.length,
      rows: Array.from(document.querySelectorAll('#aip-history .aip-row')).map(row => ({
        id: row.dataset.id,
        title: row.querySelector('.aip-row-title').textContent,
        current: row.querySelector('a').getAttribute('aria-current')
      })),
      editing: !!edit,
      editId: edit ? edit.dataset.id : null,
      editValue: input ? input.value : null,
      editSelected: input ? input.selectionEnd - input.selectionStart : 0,
      editReadOnly: input ? input.readOnly : null,
      linkHidden: edit ? edit.querySelector('a').hidden : null,
      linkTitle: edit ? edit.querySelector('a').title : null,
      focus: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}.${String(document.activeElement.className).split(' ')[0]}` : null,
      notice: q('.aip-notice').hidden ? null : q('.aip-notice').textContent,
      menu: !menu ? null : {
        labels: Array.from(menu.querySelectorAll('.aip-menu-item .aip-menu-text')).map(node => node.textContent),
        icons: Array.from(menu.querySelectorAll('.aip-menu-item .aip-menu-icon')).map(node => node.textContent),
        expanded: document.querySelector('.aip-row-menu[aria-expanded="true"]')?.closest('.aip-row').dataset.id || null,
        confirm: !menu.querySelector('.aip-menu-confirm') ? null : {
          title: menu.querySelector('.aip-menu-confirm-title').textContent,
          name: menu.querySelector('.aip-menu-confirm-name').textContent,
          buttons: Array.from(menu.querySelectorAll('.aip-menu-button')).map(node => node.textContent),
          focus: document.activeElement?.dataset.action || null
        }
      },
      drawer: {
        expanded: handle.getAttribute('aria-expanded'),
        chevron: handle.querySelector('.aip-drawer-chevron').textContent,
        previous: handle.previousElementSibling.className.includes('aip-drawer-item'),
        historyHeight: q('.aip-history').getBoundingClientRect().height,
        handleTop: handle.getBoundingClientRect().top,
        items: Array.from(document.querySelectorAll('.aip-drawer-item')).map(node => ({
          display: getComputedStyle(node).display,
          above: node.getBoundingClientRect().bottom <= handle.getBoundingClientRect().top + 1
        }))
      }
    };
  }
};

// ---- 外部驱动：真实的鼠标 / 键盘事件 ----------------------------------------------------------------

const KEYS = { Enter: [13, '\r'], Escape: [27], F2: [113], Tab: [9], ArrowDown: [40], ' ': [32, ' '] };

async function main() {
  const chromium = findChromium();
  if (!chromium) {
    console.log('没有找到能加载未打包扩展的 Chromium，跳过。可用 AIP_TEST_CHROME 指定可执行文件。');
    return true;
  }
  console.log(`浏览器：${chromium}\n`);
  const fixture = await startFixture({ total: 350 });
  const suite = createSuite('新侧栏冒烟测试');
  let browser = null;

  // 复制一份扩展到临时目录，并让它的生效范围包含仿真站点。
  const dir = join(mkdtempSync(join(tmpdir(), 'aip-smoke-')), 'extension');
  cpSync(join(ROOT, 'extension'), dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const script of manifest.content_scripts) script.matches.push(FIXTURE_MATCH);
  manifest.web_accessible_resources[0].matches.push(FIXTURE_MATCH);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const open = async (path = '/') => {
    fixture.reset();                    // 每条用例从干净的会话数据与请求日志开始
    const tab = await browser.newTab();
    await tab.goto(`${fixture.pageOrigin}${path}`);
    await tab.waitFor(async () => (await tab.evaluate(PAGE.count)) >= 100, { message: '首页会话进入侧栏', timeout: 15000 });
    await tab.evaluate(() => { window.__smokeMarker = 'kept'; });     // 整页刷新会把它冲掉
    return tab;
  };

  const mouse = tab => ({
    move: point => browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, tab.sessionId),
    async click(point, { count = 1, button = 'left' } = {}) {
      for (let i = 1; i <= count; i++) {
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: i }, tab.sessionId);
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: i }, tab.sessionId);
      }
    }
  });
  const key = async (tab, name) => {
    const [code, text] = KEYS[name];
    const base = { key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await browser.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text }, tab.sessionId);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab.sessionId);
  };
  const type = (tab, text) => browser.send('Input.insertText', { text }, tab.sessionId);
  const settle = tab => tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  // 某一行里的目标点：标题文字 (靠左取一点，避免落在行尾的三点上)。
  const rowPoint = (tab, id, selector = '.aip-row-title') => tab.evaluate(({ id, selector }) => {
    const row = document.querySelector(`.aip-row[data-id="${id}"]`);
    if (!row) return null;
    const scroll = document.querySelector('.aip-history-scroll');
    const view = scroll.getBoundingClientRect();
    const line = row.getBoundingClientRect();
    if (line.top < view.top || line.bottom > view.bottom) scroll.scrollTop += line.top - view.top - 24 - (view.height - line.height) / 2;
    const box = row.querySelector(selector).getBoundingClientRect();
    return { x: Math.round(box.left + Math.min(box.width / 2, 30)), y: Math.round(box.top + box.height / 2) };
  }, { id, selector });

  const calls = name => fixture.log.filter(entry => entry.fromExtension && entry.name === name);
  const titleOf = id => fixture.prompts.find(prompt => prompt.id === id)?.title;
  const center = (tab, selector) => tab.evaluate(selector => {
    const box = document.querySelector(selector).getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, selector);
  const selection = tab => tab.evaluate(() => ({
    active: !!document.querySelector('.aip-selection-bar:not([hidden])'),
    count: document.querySelector('.aip-selection-count')?.textContent.trim(),
    disabled: document.querySelector('.aip-selection-delete')?.disabled,
    checked: Array.from(document.querySelectorAll('.aip-row-checkbox:checked')).map(input => input.closest('.aip-row').dataset.id),
    path: location.pathname,
    confirming: !!document.querySelector('.aip-batch-dialog .aip-menu-confirm'),
    confirmation: document.querySelector('.aip-batch-dialog .aip-menu-confirm')?.textContent || ''
  }));

  try {
    browser = await Browser.launch({ executable: chromium, extensionDir: dir });

    await suite.test('挂载与对齐：New chat 文案与图标、搜索、历史流、分组标题、抽屉手柄、推广卡片', async () => {
      const tab = await open();
      try {
        const info = await tab.evaluate(() => {
          const q = selector => document.querySelector(selector);
          const style = selector => getComputedStyle(q(selector));
          const rect = selector => {
            const box = q(selector).getBoundingClientRect();
            return { left: box.left, height: box.height };
          };
          return {
            rows: document.querySelectorAll('#aip-history .aip-row').length,
            first: q('#aip-history .aip-row').dataset.id,
            groups: Array.from(document.querySelectorAll('.aip-group-title')).map(node => node.textContent),
            newChat: { text: q('a.aip-new-chat .nav-item-main-text').textContent, icon: q('a.aip-new-chat .material-symbols-outlined').textContent, h: rect('a.aip-new-chat').height },
            rowTitle: rect('.aip-row .aip-row-title'),
            rowHeight: rect('.aip-row').height,
            link: { color: style('.aip-row-link').color, weight: style('.aip-row-link').fontWeight, decoration: style('.aip-row-link').textDecorationLine },
            search: { input: rect('.aip-search-input'), padLeft: style('.aip-search-input').paddingLeft, h: rect('.aip-search').height, radius: style('.aip-search').borderRadius },
            handle: { label: rect('.aip-drawer-label'), text: q('.aip-drawer-label').textContent },
            groupTitle: { box: rect('.aip-group-title'), padLeft: style('.aip-group-title').paddingLeft },
            promo: style('ms-navbar-promo-card').display,
            roles: document.querySelectorAll('#aip-history [role="navigation"], [role="navigation"] .aip-history-scroll').length,
            searchPlaceholder: q('.aip-search-input').placeholder
          };
        });
        assert.equal(info.rows, 100);
        assert.equal(info.first, 'p0001');
        assert.equal(info.groups[0], 'Today');
        assert.deepEqual(info.newChat, { text: 'New chat', icon: 'chat_spark', h: 32 });
        assert.equal(info.searchPlaceholder, 'Search');
        // 对齐：文字列 x=45 (会话标题、搜索框文字、抽屉手柄文字)，分组标题 x=16
        assert.equal(info.rowTitle.left, 16);
        assert.equal(info.search.input.left + parseFloat(info.search.padLeft), 45);
        assert.equal(info.handle.label.left, 45);
        assert.equal(info.groupTitle.box.left + parseFloat(info.groupTitle.padLeft), 16);
        assert.equal(info.handle.text, 'Explore & Build & Manage');
        // 配色：黑白灰，不是链接蓝
        assert.notEqual(info.link.color, LINK_BLUE);
        assert.equal(info.link.weight, '500');
        assert.equal(info.link.decoration, 'none');
        // 尺寸：会话行 28px、搜索框 32px / 圆角 8px
        assert.equal(info.rowHeight, 28);
        assert.equal(info.search.h, 32);
        assert.equal(info.search.radius, '12px');
        assert.equal(info.promo, 'none');
        assert.equal(info.roles, 0, '不添加 navigation 角色 (别的扩展靠它辨认原生导航)');
        const layout = await tab.evaluate(PAGE.layout);
        assert.equal(layout.drawer.expanded, 'false');
        assert.equal(layout.drawer.chevron, 'expand_less');
        assert.equal(layout.drawer.previous, true, '手柄紧跟在抽屉内容之后');
        assert.ok(layout.drawer.items.length >= 5, 'Build / Manage 的分组都收进了抽屉');
        assert.ok(layout.drawer.items.every(item => item.display === 'none'), '默认整个收起');
      } finally {
        await tab.close();
      }
    });

    await suite.test('抽屉：点击手柄后原生分组在手柄上方展开、历史流让出高度；再点收起', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const before = (await tab.evaluate(PAGE.layout)).drawer;
        const handle = await tab.evaluate(() => {
          const box = document.querySelector('.aip-drawer').getBoundingClientRect();
          return { x: box.left + 40, y: box.top + box.height / 2 };
        });
        await m.click(handle);
        await settle(tab);
        const open_ = (await tab.evaluate(PAGE.layout)).drawer;
        assert.equal(open_.expanded, 'true');
        assert.equal(open_.chevron, 'expand_more');
        assert.ok(open_.items.every(item => item.display !== 'none'), '展开后全可见');
        assert.ok(open_.items.every(item => item.above), '内容出现在手柄上方 (向上展开)');
        assert.ok(open_.historyHeight < before.historyHeight, '历史流相应变矮');
        assert.equal(open_.handleTop, before.handleTop, '手柄留在原处');
        await m.click(handle);
        await settle(tab);
        const closed = (await tab.evaluate(PAGE.layout)).drawer;
        assert.equal(closed.expanded, 'false');
        assert.ok(closed.items.every(item => item.display === 'none'));
        assert.equal(closed.historyHeight, before.historyHeight);
      } finally {
        await tab.close();
      }
    });

    await suite.test('单击切换、双击编辑：未选中的会话切换一次后原位进入编辑，标题全选，不整页刷新', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const before = await tab.evaluate(PAGE.layout);
        const point = await rowPoint(tab, 'p0003');
        await m.move(point);
        await m.click(point);
        assert.equal((await tab.evaluate(PAGE.layout)).path, '/prompts/p0003', '单击立即切换');
        assert.equal((await tab.evaluate(PAGE.layout)).rows.find(row => row.id === 'p0003').current, 'page');
        assert.equal((await tab.evaluate(PAGE.layout)).editing, false, '单击不进入编辑');
        await m.click(point, { count: 2 });
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).editing, { message: '进入原位编辑' });
        const after = await tab.evaluate(PAGE.layout);
        assert.equal(after.editId, 'p0003');
        assert.equal(after.editValue, titleOf('p0003'));
        assert.equal(after.editSelected, after.editValue.length, '标题全选');
        assert.equal(after.linkHidden, true);
        assert.equal(after.focus, 'input.aip-row-edit');
        assert.equal(after.history, before.history + 1, '双击只压入一条历史记录');
        assert.equal(after.marker, 'kept', '没有整页刷新');
        assert.equal(after.rows.find(row => row.id === 'p0003').current, 'page', '编辑不影响当前会话高亮');
      } finally {
        await tab.close();
      }
    });

    await suite.test('Enter 保存：先取完整会话再提交；连按 Enter 只提交一次；列表、焦点、提示同步', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const point = await rowPoint(tab, 'p0003');
        await m.move(point);
        await m.click(point, { count: 2 });
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).editing, { message: '进入原位编辑' });
        await type(tab, '  Grid   plan  ');
        await key(tab, 'Enter');
        await key(tab, 'Enter');
        await key(tab, 'Enter');
        await tab.waitFor(async () => !(await tab.evaluate(PAGE.layout)).editing, { message: '保存后退出编辑' });
        const after = await tab.evaluate(PAGE.layout);
        assert.equal(after.rows.find(row => row.id === 'p0003').title, 'Grid plan', '标题去首尾空白、连续空白合并');
        assert.equal(after.focus, 'a.aip-row-link', '焦点交还给链接');
        assert.equal(after.notice, 'Renamed');
        assert.equal(titleOf('p0003'), 'Grid plan');
        const resolve = calls('ResolveDriveResource');
        const update = calls('UpdatePrompt');
        assert.equal(resolve.length, 1);
        assert.deepEqual(resolve[0].body, ['p0003'], '按官方做法先取完整会话 (不带 prompts/ 前缀)');
        assert.equal(update.length, 1, '重复按 Enter 不会重复提交');
        assert.equal(update[0].body[0][0], 'prompts/p0003');
        assert.equal(update[0].body[0][4][0], 'Grid plan');
        assert.deepEqual(update[0].body[0][3], [['gemini-fixture'], [1, 1, 1]], '提交的是完整会话记录 (带模型配置)，不是列表里的精简记录');
      } finally {
        await tab.close();
      }
    });

    await suite.test('Esc 取消并恢复原名；F2 进入编辑；空白标题提示且不提交', async () => {
      const tab = await open();
      try {
        const original = titleOf('p0005');
        const point = await rowPoint(tab, 'p0005');
        const m = mouse(tab);
        await m.move(point);
        await m.click(point, { count: 2 });
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).editing, { message: '进入原位编辑' });
        await type(tab, 'zzz');
        await key(tab, 'Escape');
        await tab.waitFor(async () => !(await tab.evaluate(PAGE.layout)).editing, { message: '退出编辑' });
        let state = await tab.evaluate(PAGE.layout);
        assert.equal(state.rows.find(row => row.id === 'p0005').title, original);
        assert.equal(state.focus, 'a.aip-row-link');
        assert.equal(calls('UpdatePrompt').length, 0, '取消不发请求');

        // F2：焦点在链接上时进入编辑
        await tab.evaluate(id => document.querySelector(`.aip-row[data-id="${id}"] a`).focus(), 'p0005');
        await key(tab, 'F2');
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).editing, { message: 'F2 进入编辑' });
        await type(tab, '   ');
        await key(tab, 'Enter');
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).notice === 'Enter a title', { message: '空白标题提示' });
        state = await tab.evaluate(PAGE.layout);
        assert.equal(state.editing, true, '保留编辑状态');
        assert.equal(state.rows.find(row => row.id === 'p0005').title, original, '列表保留原名');
        assert.equal(await tab.evaluate(() => document.querySelector('.aip-row-edit').getAttribute('aria-invalid')), 'true');
        assert.equal(calls('UpdatePrompt').length, 0, '空白标题不提交');
        assert.equal(titleOf('p0005'), original);
      } finally {
        await tab.close();
      }
    });

    await suite.test('中文输入法选词时 Enter 和 Esc 不触发保存或取消', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const point = await rowPoint(tab, 'p0007');
        await m.move(point);
        await m.click(point, { count: 2 });
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).editing);
        await tab.evaluate(() => {
          const input = document.querySelector('.aip-row-edit');
          input.value = '中文标题';
          for (const key of ['Enter', 'Escape']) {
            input.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true }));
          }
        });
        const state = await tab.evaluate(PAGE.layout);
        assert.equal(state.editing, true);
        assert.equal(state.editValue, '中文标题');
        assert.equal(calls('UpdatePrompt').length, 0);
        await key(tab, 'Escape');
      } finally { await tab.close(); }
    });

    await suite.test('保存失败：列表改回原名、输入框与草稿保留并给出原因；再按 Enter 重试成功', async () => {
      const tab = await open();
      try {
        fixture.fail('UpdatePrompt', 500);     // 放在 open() 之后：open 会重置服务器状态
        const original = titleOf('p0007');
        const point = await rowPoint(tab, 'p0007');
        const m = mouse(tab);
        await m.move(point);
        await m.click(point, { count: 2 });
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).editing, { message: '进入原位编辑' });
        await type(tab, 'Retry me');
        await key(tab, 'Enter');
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).notice, { message: '失败提示' });
        const failed = await tab.evaluate(PAGE.layout);
        assert.match(failed.notice, /^Couldn't rename this chat — /);
        assert.equal(failed.editing, true, '仍在编辑状态');
        assert.equal(failed.editValue, 'Retry me', '草稿保留');
        assert.equal(failed.editReadOnly, false, '可以继续修改');
        assert.equal(failed.linkTitle, original, '列表里已是原名');
        assert.equal(titleOf('p0007'), original);

        await key(tab, 'Enter');
        await tab.waitFor(async () => !(await tab.evaluate(PAGE.layout)).editing, { message: '重试成功' });
        assert.equal(titleOf('p0007'), 'Retry me');
        assert.equal(calls('UpdatePrompt').length, 2);
      } finally {
        await tab.close();
      }
    });

    await suite.test('三点菜单：四项与图标、右缘对齐三点按钮、Esc 把焦点交还、点外部关闭、方向键移动', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const point = await rowPoint(tab, 'p0009', '.aip-row-menu');
        await m.move(await rowPoint(tab, 'p0009'));
        await m.click(point);
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu, { message: '菜单出现' });
        let state = await tab.evaluate(PAGE.layout);
        assert.deepEqual(state.menu.labels, ['Rename', 'Share', 'Make a copy', 'Select', 'Delete']);
        assert.deepEqual(state.menu.icons, ['edit', 'share', 'content_copy', 'checklist', 'delete']);
        assert.equal(state.menu.expanded, 'p0009');
        assert.equal(state.focus, 'button.aip-menu-item');
        const geometry = await tab.evaluate(() => {
          const panel = document.querySelector('.aip-menu').getBoundingClientRect();
          const button = document.querySelector('.aip-row[data-id="p0009"] .aip-row-menu').getBoundingClientRect();
          const style = getComputedStyle(document.querySelector('.aip-menu'));
          return { left: panel.left, buttonRight: button.right, top: panel.top, buttonTop: button.top, radius: style.borderRadius, itemHeight: document.querySelector('.aip-menu-item').getBoundingClientRect().height };
        });
        assert.ok(Math.abs(geometry.left - geometry.buttonRight - 4) <= 1, '菜单向右展开');
        assert.ok(Math.abs(geometry.top - geometry.buttonTop) <= 1, '菜单顶部与按钮对齐');
        assert.equal(geometry.radius, '8px');
        assert.equal(geometry.itemHeight, 32);

        await key(tab, 'Escape');
        assert.equal((await tab.evaluate(PAGE.layout)).menu, null, 'Esc 关闭');
        assert.equal((await tab.evaluate(PAGE.layout)).focus, 'button.aip-row-menu', '焦点交还给三点按钮');
        assert.equal((await tab.evaluate(PAGE.layout)).rows.find(row => row.id === 'p0009').title, titleOf('p0009'));

        await m.move(await rowPoint(tab, 'p0009'));
        await m.click(point);
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu, { message: '菜单再次出现' });
        await m.click({ x: 700, y: 600 });
        await tab.waitFor(async () => !(await tab.evaluate(PAGE.layout)).menu, { message: '点外部关闭' });

        await m.move(await rowPoint(tab, 'p0009'));
        await m.click(point);
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu, { message: '菜单第三次出现' });
        await key(tab, 'ArrowDown');
        await key(tab, 'ArrowDown');
        assert.equal(await tab.evaluate(() => document.activeElement.querySelector('.aip-menu-text').textContent), 'Make a copy');
        await key(tab, 'Escape');
      } finally {
        await tab.close();
      }
    });

    await suite.test('右键会话行：弹出同一个菜单', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const point = await rowPoint(tab, 'p0011');
        await m.move(point);
        await m.click(point, { button: 'right' });
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu, { message: '菜单出现' });
        const state = await tab.evaluate(PAGE.layout);
        assert.deepEqual(state.menu.labels, ['Rename', 'Share', 'Make a copy', 'Select', 'Delete']);
        assert.equal(state.menu.expanded, 'p0011');
        assert.equal(state.path, '/');
        await key(tab, 'Escape');
      } finally {
        await tab.close();
      }
    });

    await suite.test('会话菜单 Select 只选择当前行，不删除或导航', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const point = await rowPoint(tab, 'p0011');
        await m.move(point);
        await m.click(point, { button: 'right' });
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu);
        await m.click(await center(tab, '.aip-menu [data-action="select"]'));
        await tab.waitFor(async () => (await selection(tab)).active);
        const result = await selection(tab);
        assert.deepEqual(result.checked, ['p0011']);
        assert.equal(result.path, '/');
        assert.equal(calls('DeletePrompt').length, 0);
      } finally { await tab.close(); }
    });

    await suite.test('Share：在 History 定位对应会话行并调用该行的原生 Share', async () => {
      const tab = await open('/prompts/p0001');
      try {
        await tab.evaluate(() => {
          const makeHistoryTable = () => {
            if (location.pathname !== '/library' || document.querySelector('#fixture-history')) return;
            const table = document.createElement('table');
            table.id = 'fixture-history';
            // 包含其他会话，验证不能误选第一行或当前打开的会话。
            for (const id of ['p0001', 'p0011']) {
              const row = table.insertRow();
              const cell = row.insertCell();
              const link = document.createElement('a');
              link.href = `/prompts/${id}`;
              link.textContent = `Session ${id}`;
              cell.append(link);
              const more = document.createElement('button');
              more.setAttribute('aria-label', 'More options');
              more.textContent = 'More';
              more.addEventListener('click', () => {
                document.body.dataset.menuFor = id;
                const item = document.createElement('button');
                item.setAttribute('role', 'menuitem');
                item.textContent = 'share Share';
                item.addEventListener('click', () => { document.body.dataset.shared = id; });
                document.body.append(item);
              });
              cell.append(more);
            }
            document.body.append(table);
          };
          window.addEventListener('popstate', makeHistoryTable);
          makeHistoryTable();
        });
        const m = mouse(tab);
        await m.move(await rowPoint(tab, 'p0011'));
        await m.click(await rowPoint(tab, 'p0011', '.aip-row-menu'));
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu, { message: '侧栏菜单出现' });
        await m.click(await tab.evaluate(() => {
          const box = document.querySelector('.aip-menu-item[data-action="share"]').getBoundingClientRect();
          return { x: box.left + 20, y: box.top + box.height / 2 };
        }));
        await tab.waitFor(() => tab.evaluate(() => document.body.dataset.shared === 'p0011'), { timeout: 10000, message: '目标行原生 Share 被触发' });
        assert.equal(await tab.evaluate(() => location.pathname), '/library');
        assert.equal(await tab.evaluate(() => document.body.dataset.menuFor), 'p0011');
      } finally { await tab.close(); }
    });

    await suite.test('Make a copy：取完整会话、清空资源名、标题加前缀；新会话刷新后出现在列表顶部', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const title = titleOf('p0011');
        await m.move(await rowPoint(tab, 'p0011'));
        await m.click(await rowPoint(tab, 'p0011', '.aip-row-menu'));
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu, { message: '菜单出现' });
        const item = await tab.evaluate(() => {
          const box = document.querySelector('.aip-menu-item[data-action="copy"]').getBoundingClientRect();
          return { x: box.left + 20, y: box.top + box.height / 2 };
        });
        await m.click(item);
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).notice === 'Copy created', { message: '复制成功提示' });
        const create = calls('CreatePrompt');
        assert.equal(create.length, 1);
        assert.equal(create[0].body[0][0], '', '与官方一致：清空资源名后按新建提交');
        assert.equal(create[0].body[0][4][0], `Copy of ${title}`);
        assert.equal(titleOf('created-1'), `Copy of ${title}`);
        await tab.waitFor(async () => (await tab.evaluate(PAGE.rows))[0].title === `Copy of ${title}`, { message: '新会话出现在列表顶部' });
        assert.equal((await tab.evaluate(PAGE.layout)).path, '/', '复制不跳转');
      } finally {
        await tab.close();
      }
    });

    await suite.test('Delete：面板内确认且焦点在"取消"；回车取消不动数据；确认后请求、行消失、提示回收站', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        const openMenu = async id => {
          await m.move(await rowPoint(tab, id));
          await m.click(await rowPoint(tab, id, '.aip-row-menu'));
          await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu, { message: '菜单出现' });
          await m.click(await tab.evaluate(() => {
            const box = document.querySelector('.aip-menu-item[data-action="delete"]').getBoundingClientRect();
            return { x: box.left + 20, y: box.top + box.height / 2 };
          }));
          await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu?.confirm, { message: '确认框出现' });
        };
        await openMenu('p0013');
        const confirm = (await tab.evaluate(PAGE.layout)).menu.confirm;
        assert.equal(confirm.title, 'Move to trash?');
        assert.equal(confirm.name, titleOf('p0013'));
        assert.deepEqual(confirm.buttons, ['Cancel', 'Delete']);
        assert.equal(confirm.focus, 'cancel', '焦点默认在取消上');

        await key(tab, 'Enter');
        await tab.waitFor(async () => !(await tab.evaluate(PAGE.layout)).menu, { message: '取消后菜单关闭' });
        assert.ok(titleOf('p0013'), '取消不删');
        assert.equal(calls('DeletePrompt').length, 0);

        await openMenu('p0013');
        await m.click(await tab.evaluate(() => {
          const box = document.querySelector('.aip-menu-button[data-action="confirm"]').getBoundingClientRect();
          return { x: box.left + 10, y: box.top + box.height / 2 };
        }));
        await tab.waitFor(async () => !(await tab.evaluate(PAGE.rows)).some(row => row.id === 'p0013'), { message: '行消失' });
        assert.equal(titleOf('p0013'), undefined);
        const remove = calls('DeletePrompt');
        assert.equal(remove.length, 1);
        assert.deepEqual(remove[0].body, ['prompts/p0013']);
        assert.match((await tab.evaluate(PAGE.layout)).notice, /^Moved to trash/);
        assert.equal((await tab.evaluate(PAGE.layout)).menu, null);
      } finally {
        await tab.close();
      }
    });

    await suite.test('删除当前打开的会话后回到 History 页', async () => {
      const tab = await open('/prompts/p0002');
      try {
        const m = mouse(tab);
        await m.move(await rowPoint(tab, 'p0002'));
        await m.click(await rowPoint(tab, 'p0002', '.aip-row-menu'));
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu, { message: '菜单出现' });
        await m.click(await tab.evaluate(() => {
          const box = document.querySelector('.aip-menu-item[data-action="delete"]').getBoundingClientRect();
          return { x: box.left + 20, y: box.top + box.height / 2 };
        }));
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).menu?.confirm, { message: '确认框出现' });
        await m.click(await tab.evaluate(() => {
          const box = document.querySelector('.aip-menu-button[data-action="confirm"]').getBoundingClientRect();
          return { x: box.left + 10, y: box.top + box.height / 2 };
        }));
        await tab.waitFor(async () => (await tab.evaluate(PAGE.layout)).path === '/library', { message: '回到 History 页' });
        assert.equal((await tab.evaluate(PAGE.layout)).marker, 'kept', '站内切换，不整页刷新');
      } finally {
        await tab.close();
      }
    });

    await suite.test('多选入口：搜索框独立，勾选与当前会话分离，搜索隐藏的选中项仍计数', async () => {
      const tab = await open('/prompts/p0003');
      try {
        const m = mouse(tab);
        assert.ok(await tab.evaluate(() => !!document.querySelector('.aip-select-start')));
        assert.equal(await tab.evaluate(() => document.querySelector('.aip-search').contains(document.querySelector('.aip-select-start'))), false);
        await m.click(await center(tab, '.aip-select-start'));
        await tab.waitFor(async () => (await selection(tab)).active, { message: '进入多选模式' });
        let state = await selection(tab);
        assert.match(state.count, /0/);
        assert.equal(state.disabled, true, '空选择不能删除');
        for (const id of ['p0001', 'p0002']) await m.click(await rowPoint(tab, id));
        state = await selection(tab);
        assert.deepEqual(state.checked.sort(), ['p0001', 'p0002']);
        assert.match(state.count, /2/);
        assert.equal(state.path, '/prompts/p0003', '选择会话不会改变当前会话');
        await m.click(await center(tab, '.aip-search-input'));
        await type(tab, '0001');
        await tab.waitFor(async () => await tab.evaluate(() => document.querySelector('.aip-row[data-id="p0002"]').getBoundingClientRect().height === 0), { message: '搜索隐藏另一条已选会话' });
        assert.match((await selection(tab)).count, /2/, '隐藏的选中项仍计数');
        await m.click(await center(tab, '.aip-selection-delete'));
        await tab.waitFor(async () => (await selection(tab)).confirming, { message: '批量删除确认' });
        state = await selection(tab);
        assert.match(state.confirmation, /2/);
        assert.match(state.confirmation, /hidden/i, '确认框说明搜索隐藏项');
        await m.click({ x: 700, y: 600 });
        await tab.waitFor(async () => !(await selection(tab)).confirming, { message: '点外部关闭批量确认框' });
        await m.click(await center(tab, '.aip-selection-delete'));
        await tab.waitFor(async () => (await selection(tab)).confirming, { message: '再次打开批量确认框' });
        await m.click(await center(tab, '.aip-batch-dialog [data-action="cancel"]'));
        await tab.waitFor(async () => !(await selection(tab)).confirming, { message: '取消关闭批量确认框' });
        assert.equal(calls('DeletePrompt').length, 0);
        await key(tab, 'Escape');
        await tab.waitFor(async () => !(await selection(tab)).active, { message: 'Esc 退出多选' });
      } finally { await tab.close(); }
    });

    await suite.test('长按：移动取消，长按释放只选中该行，不导航或立刻取消选择', async () => {
      const tab = await open('/prompts/p0003');
      try {
        const m = mouse(tab);
        const p = await rowPoint(tab, 'p0001');
        await m.move(p);
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 }, tab.sessionId);
        await m.move({ x: p.x + 25, y: p.y + 15 });
        await new Promise(resolve => setTimeout(resolve, 650));
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 25, y: p.y + 15, button: 'left', clickCount: 1 }, tab.sessionId);
        assert.equal((await selection(tab)).active, false, '拖动不会误触长按');
        await m.move(p);
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 }, tab.sessionId);
        await tab.waitFor(async () => (await selection(tab)).active, { timeout: 2000, message: '达到阈值时尚未松手即进入多选' });
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 }, tab.sessionId);
        const state = await selection(tab);
        assert.deepEqual(state.checked, ['p0001']);
        assert.equal(state.path, '/prompts/p0003', '松手不会导航');
        await m.click(await center(tab, '.aip-selection-exit'));
        await tab.waitFor(async () => !(await selection(tab)).active, { message: '关闭多选' });
      } finally { await tab.close(); }
    });

    await suite.test('批量删除：逐项处理失败，失败项保留，重试成功后退出', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        await m.click(await center(tab, '.aip-select-start'));
        for (const id of ['p0001', 'p0002']) await m.click(await rowPoint(tab, id));
        fixture.fail('DeletePrompt', 500);
        await m.click(await center(tab, '.aip-selection-delete'));
        await tab.waitFor(async () => (await selection(tab)).confirming, { message: '确认框出现' });
        await m.click(await center(tab, '.aip-batch-dialog [data-action="confirm"]'));
        await tab.waitFor(async () => calls('DeletePrompt').length === 2 && (await selection(tab)).checked.length === 1, { timeout: 15000, message: '部分删除完成' });
        let state = await selection(tab);
        assert.equal(state.active, true, '部分失败保留选择模式');
        assert.deepEqual(state.checked, ['p0001']);
        assert.ok(fixture.prompts.some(prompt => prompt.id === 'p0001'));
        assert.ok(!fixture.prompts.some(prompt => prompt.id === 'p0002'));
        await m.click(await center(tab, '.aip-selection-delete'));
        await tab.waitFor(async () => (await selection(tab)).confirming);
        await m.click(await center(tab, '.aip-batch-dialog [data-action="confirm"]'));
        await tab.waitFor(async () => !(await selection(tab)).active, { timeout: 15000, message: '全部成功后退出' });
        assert.ok(!fixture.prompts.some(prompt => prompt.id === 'p0001'));
      } finally { await tab.close(); }
    });

    await suite.test('批量删除当前会话：成功后回到 History', async () => {
      const tab = await open('/prompts/p0003');
      try {
        const m = mouse(tab);
        await m.click(await center(tab, '.aip-select-start'));
        await m.click(await rowPoint(tab, 'p0003'));
        await m.click(await center(tab, '.aip-selection-delete'));
        await tab.waitFor(async () => (await selection(tab)).confirming);
        await m.click(await center(tab, '.aip-batch-dialog [data-action="confirm"]'));
        await tab.waitFor(async () => (await selection(tab)).path === '/library', { timeout: 15000, message: '回到 History' });
        assert.ok(!fixture.prompts.some(prompt => prompt.id === 'p0003'));
      } finally { await tab.close(); }
    });

    await suite.test('多选键盘操作：复选框空格只切换一次，Esc 返回入口', async () => {
      const tab = await open('/prompts/p0003');
      try {
        const m = mouse(tab);
        await m.click(await center(tab, '.aip-select-start'));
        await tab.evaluate(() => document.querySelector('.aip-row[data-id="p0001"] .aip-row-checkbox').focus());
        await key(tab, ' ');
        let state = await selection(tab);
        assert.deepEqual(state.checked, ['p0001']);
        assert.equal(state.path, '/prompts/p0003');
        await key(tab, ' ');
        state = await selection(tab);
        assert.deepEqual(state.checked, []);
        assert.equal(state.active, true);
        await key(tab, 'Escape');
        state = await selection(tab);
        assert.equal(state.active, false);
        assert.equal(await tab.evaluate(() => document.activeElement.classList.contains('aip-select-start')), true);
      } finally { await tab.close(); }
    });

    await suite.test('多选时导航重建：选择、筛选文本和筛选结果一致保留', async () => {
      const tab = await open('/prompts/p0003');
      try {
        const m = mouse(tab);
        await m.click(await center(tab, '.aip-select-start'));
        await m.click(await rowPoint(tab, 'p0001'));
        await m.click(await center(tab, '.aip-search-input'));
        await type(tab, '0001');
        await tab.waitFor(async () => await tab.evaluate(() => document.querySelector('.aip-row[data-id="p0002"]').getBoundingClientRect().height === 0));
        await tab.evaluate(() => {
          const current = document.querySelector('ms-navbar-v2');
          const fresh = current.cloneNode(true);
          fresh.querySelector('#aip-history').remove();
          fresh.querySelector('.aip-drawer')?.remove();
          for (const node of fresh.querySelectorAll('.aip-new-chat, .aip-drawer-item, .aip-drawer-title')) {
            for (const name of Array.from(node.classList)) if (name.startsWith('aip-')) node.classList.remove(name);
          }
          current.replaceWith(fresh);
        });
        await tab.waitFor(async () => await tab.evaluate(() => !!document.querySelector('.aip-selection-bar:not([hidden])')));
        assert.equal(await tab.evaluate(() => document.querySelector('.aip-search-input').value), '0001');
        assert.deepEqual((await selection(tab)).checked, ['p0001']);
        assert.equal(await tab.evaluate(() => document.querySelector('.aip-row[data-id="p0002"]')?.getBoundingClientRect().height || 0), 0);
      } finally { await tab.close(); }
    });

    await suite.test('长按时滚动列表取消手势，不进入多选', async () => {
      const tab = await open('/prompts/p0003');
      try {
        const m = mouse(tab);
        const p = await rowPoint(tab, 'p0001');
        await m.move(p);
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 }, tab.sessionId);
        await tab.evaluate(() => { document.querySelector('.aip-history-scroll').scrollTop += 80; });
        await new Promise(resolve => setTimeout(resolve, 650));
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 }, tab.sessionId);
        assert.equal((await selection(tab)).active, false);
      } finally { await tab.close(); }
    });

    await suite.test('批量删除网络中断：保留不确定项并阻止直接重复删除', async () => {
      const tab = await open();
      try {
        const m = mouse(tab);
        await m.click(await center(tab, '.aip-select-start'));
        await m.click(await rowPoint(tab, 'p0001'));
        fixture.fail('DeletePrompt', 'network');
        await m.click(await center(tab, '.aip-selection-delete'));
        await tab.waitFor(async () => (await selection(tab)).confirming);
        await m.click(await center(tab, '.aip-batch-dialog [data-action="confirm"]'));
        try {
          await tab.waitFor(async () => /unknown/i.test(await tab.evaluate(() => document.querySelector('.aip-notice').textContent)), { timeout: 15000, message: '显示不确定结果' });
        } catch (error) {
          error.message += `; state=${JSON.stringify(await selection(tab))}; deleteCalls=${JSON.stringify(fixture.log.filter(e => e.name === 'DeletePrompt').map(e => ({ status: e.status, fromExtension: e.fromExtension })))}`;
          throw error;
        }
        let state = await selection(tab);
        assert.equal(state.active, true);
        assert.deepEqual(state.checked, ['p0001']);
        assert.equal(state.disabled, true, '存在不确定项时禁用直接重复删除');
        assert.equal(await tab.evaluate(() => document.querySelector('.aip-row[data-id="p0001"]').dataset.uncertain), 'true');
        assert.match(await tab.evaluate(() => document.querySelector('.aip-notice').textContent), /unknown/i);
        assert.ok(fixture.prompts.some(prompt => prompt.id === 'p0001'));

        const deleteCountBefore = calls('DeletePrompt').length;
        await m.click(await center(tab, '.aip-selection-delete'));
        assert.equal((await selection(tab)).confirming, false, '禁用时不弹出确认框');
        assert.equal(calls('DeletePrompt').length, deleteCountBefore, '不确定项阻止发起额外删除请求');

        await m.click(await rowPoint(tab, 'p0002'));
        assert.equal((await selection(tab)).disabled, true, '仍有不确定项时仍禁用删除');
        await m.click(await rowPoint(tab, 'p0001'));
        state = await selection(tab);
        assert.deepEqual(state.checked, ['p0002']);
        assert.equal(state.disabled, false, '取消勾选不确定项后恢复删除按钮');
        assert.equal(await tab.evaluate(() => document.querySelector('.aip-row[data-id="p0001"]').dataset.uncertain), undefined);

        await m.click(await center(tab, '.aip-selection-exit'));
        await tab.waitFor(async () => !(await selection(tab)).active, { message: '可正常退出多选' });
      } finally { await tab.close(); }
    });
  } finally {
    await browser?.close();
    await fixture.close();
    rmSync(dirname(dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  return suite.summary();
}

process.exit((await main()) ? 0 : 1);
