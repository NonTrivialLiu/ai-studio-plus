/**
 * 真实扩展集成测试：用本机的 Chromium 真正加载扩展 (走真实的 MAIN / ISOLATED 双世界机制)，
 * 访问本地的 AI Studio 仿真站点 (tests/browser/server.mjs)，只从外部观察点验证行为：
 * DOM、地址栏、以及仿真服务器实际收到的请求。不读取扩展内部状态。
 *
 *   node tests/browser/run.mjs        可用环境变量 AIP_TEST_CHROME 指定 Chromium / Chrome for Testing
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Browser, createSuite, findChromium } from './cdp.mjs';
import { startFixture } from './server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_MATCH = 'http://127.0.0.1/*';
const stagedDirs = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- 页面内的观察点：每个函数都会被序列化后送进页面执行，必须自包含 ---------------------------------

const PAGE = {
  rows: () => Array.from(document.querySelectorAll('#aip-history .aip-row')).map(row => ({
    href: row.querySelector('.aip-row-link').getAttribute('href'),
    hidden: row.hidden,
    title: row.title
  })),
  groups: () => Array.from(document.querySelectorAll('#aip-history .aip-group'))
    .map(group => [group.firstElementChild.textContent, group.querySelectorAll('.aip-row:not([hidden])').length]),
  status: () => {
    const root = document.querySelector('#aip-history');
    return root && { kind: root.dataset.state, text: root.querySelector('.aip-status-text').textContent };
  },
  active: () => document.querySelector('#aip-history .aip-row-link[aria-current="page"]')?.getAttribute('href') || null,
  toBottom: () => { document.querySelector('.aip-history-scroll').scrollTop = 1e9; },
  topRow: () => {
    const list = document.querySelector('.aip-history-scroll');
    const top = list.getBoundingClientRect().top;
    for (const row of list.querySelectorAll('.aip-row')) {
      if (row.hidden) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top) return { href: row.querySelector('.aip-row-link').getAttribute('href'), offset: Math.round((rect.top - top) * 10) / 10 };
    }
    return null;
  },
  // 等两帧，让滚动位置与布局稳定下来。
  settle: () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  search: query => {
    const input = document.querySelector('#aip-history .aip-search-input');
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
};

async function waitRows(tab, count, timeout = 15000) {
  return tab.waitFor(async () => {
    const rows = await tab.evaluate(PAGE.rows);
    return rows.length >= count ? rows : null;
  }, { timeout });
}

const visible = rows => rows.filter(row => !row.hidden).map(row => row.href);
const extensionLists = fixture => fixture.log.filter(entry => entry.fromExtension && entry.name === 'ListPrompts');

// 复制一份扩展到临时目录，并让它的生效范围包含仿真站点。mainWorld = false 模拟不认 world: "MAIN" 的浏览器。
function stageExtension({ mainWorld = true } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'aip-extension-')), 'extension');
  stagedDirs.push(dir);
  cpSync(join(ROOT, 'extension'), dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.content_scripts = manifest.content_scripts.filter(script => mainWorld || script.world !== 'MAIN');
  for (const script of manifest.content_scripts) script.matches.push(FIXTURE_MATCH);
  manifest.web_accessible_resources[0].matches.push(FIXTURE_MATCH);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return dir;
}

async function main() {
  const chromium = findChromium();
  if (!chromium) {
    console.log('没有找到能加载未打包扩展的 Chromium，跳过。可用 AIP_TEST_CHROME 指定可执行文件。');
    return true;
  }
  console.log(`浏览器：${chromium}\n`);
  const fixture = await startFixture({ total: 350 });
  const browsers = [];
  const suite = createSuite('真实扩展集成测试');
  let browser = null;

  const open = async (path = '/') => {
    fixture.reset();                    // 每条用例从干净的会话数据与请求日志开始
    const tab = await browser.newTab();
    await tab.goto(`${fixture.pageOrigin}${path}`);
    return tab;
  };
  // 打开一个会话页并等首页 (100 条) 到达侧栏。
  const openChatPage = async () => {
    const tab = await open('/');
    await waitRows(tab, 100);
    return tab;
  };

  try {
    browser = await Browser.launch({ executable: chromium, extensionDir: stageExtension() });
    browsers.push(browser);

    // node tests/browser/run.mjs --only 关键字：只跑名称包含关键字的用例。
    const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
    const test = (name, fn) => (only && !name.includes(only) ? suite.skip(name) : suite.test(name, fn));
    await test('页面加载后，首页会话经主世界 → 扩展世界进入侧栏，并按时间分组、按更新时间降序', async () => {
      const tab = await openChatPage();
      try {
        const rows = await tab.evaluate(PAGE.rows);
        assert.equal(rows.length, 100);
        assert.equal(rows[0].href, '/prompts/p0001');
        assert.equal(rows[99].href, '/prompts/p0100');
        assert.equal(rows[0].title, '会话 0001：电网拓扑优化', '只带标题，不带作者等信息');
        const groups = await tab.evaluate(PAGE.groups);
        assert.equal(groups[0][0], 'Today');
        const order = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Earlier'];
        assert.ok(order.indexOf(groups[groups.length - 1][0]) > 0, '跨到更早的分组');
        for (let i = 1; i < groups.length; i++) assert.ok(order.indexOf(groups[i][0]) > order.indexOf(groups[i - 1][0]), '分组顺序与站点语言一致');
        assert.equal(await tab.evaluate(() => document.querySelectorAll('ms-navbar-v2 #aip-history').length), 1, '历史流嵌在导航里且只有一份');
      } finally {
        await tab.close();
      }
    });

    await test('触底自动取下一页直到取完；代发的请求带 Cookie 与鉴权头、沿用页面的每页条数和游标', async () => {
      const tab = await openChatPage();
      try {
        for (const expected of [200, 300, 350]) {
          await tab.evaluate(PAGE.toBottom);
          await waitRows(tab, expected);
        }
        const status = await tab.waitFor(async () => {
          const status = await tab.evaluate(PAGE.status);
          return status.kind === 'done' ? status : null;
        });
        assert.equal(status.text, 'End of history');
        const lists = extensionLists(fixture);
        assert.equal(lists.length, 3, '只代发了第 2、3、4 页');
        assert.ok(lists.every(entry => entry.cookie && entry.authorization === 'SAPISIDHASH 1_test'), '每个代发请求都带凭据');
        assert.deepStrictEqual(lists.map(entry => entry.body), [[100, 't100'], [100, 't200'], [100, 't300']]);
        await tab.evaluate(PAGE.toBottom);
        await sleep(1500);
        assert.equal(extensionLists(fixture).length, 3, '到底后不再请求');
      } finally {
        await tab.close();
      }
    });

    await test('不滚动时不会主动多取 (首页到达后保持 100 条)', async () => {
      const tab = await openChatPage();
      try {
        await sleep(5500);          // 越过"页面刚送来一页"的静置期
        assert.equal((await tab.evaluate(PAGE.rows)).length, 100);
        assert.equal(extensionLists(fixture).length, 0);
      } finally {
        await tab.close();
      }
    });

    await test('History 页自己连续翻页时，扩展只是跟着吸收数据，不重复请求', async () => {
      const tab = await open('/library');
      try {
        await waitRows(tab, 350);
        assert.equal((await tab.evaluate(PAGE.groups)).map(group => group[1]).reduce((sum, n) => sum + n, 0), 350);
        await sleep(5500);
        assert.equal(extensionLists(fixture).length, 0);
      } finally {
        await tab.close();
      }
    });

    await test('点击会话行：站内切换 (不整页刷新)，当前行高亮；浏览器后退时高亮跟随', async () => {
      const tab = await openChatPage();
      try {
        const origin = await tab.evaluate(() => performance.timeOrigin);
        await tab.evaluate(() => document.querySelectorAll('#aip-history .aip-row-link')[2].click());
        await tab.waitFor(() => tab.evaluate(() => location.pathname === '/prompts/p0003'));
        assert.equal(await tab.evaluate(() => performance.timeOrigin), origin, '页面没有重新加载');
        assert.equal(await tab.evaluate(PAGE.active), '/prompts/p0003');
        await tab.evaluate(() => history.back());
        await tab.waitFor(() => tab.evaluate(() => location.pathname === '/'));
        assert.equal(await tab.evaluate(PAGE.active), null);
      } finally {
        await tab.close();
      }
    });

    await test('按住修饰键点击会话行时保留浏览器原生行为，不拦截', async () => {
      const tab = await openChatPage();
      try {
        const handled = await tab.evaluate(() => {
          const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
          document.querySelectorAll('#aip-history .aip-row-link')[5].dispatchEvent(event);
          return event.defaultPrevented;
        });
        assert.equal(handled, false);
      } finally {
        await tab.close();
      }
    });

    await test('直接打开某个会话页：对应行高亮，并被滚进侧栏可视区', async () => {
      const tab = await open('/prompts/p0042');
      try {
        await waitRows(tab, 100);
        assert.equal(await tab.evaluate(PAGE.active), '/prompts/p0042');
        const onScreen = await tab.evaluate(() => {
          const box = document.querySelector('.aip-history-scroll').getBoundingClientRect();
          const rect = document.querySelector('#aip-history .aip-row-link[aria-current="page"]').getBoundingClientRect();
          return rect.top >= box.top && rect.bottom <= box.bottom;
        });
        assert.equal(onScreen, true);
      } finally {
        await tab.close();
      }
    });

    await test('搜索：输入后过滤已加载的会话；关键字只命中很早的会话时，后台把剩下的分页取完', async () => {
      const tab = await openChatPage();
      try {
        await tab.evaluate(PAGE.search, 'session 001');
        await tab.waitFor(async () => visible(await tab.evaluate(PAGE.rows)).length === 5, { timeout: 4000, message: '本地过滤出 5 条命中' });
        assert.deepStrictEqual(visible(await tab.evaluate(PAGE.rows)), ['/prompts/p0010', '/prompts/p0012', '/prompts/p0014', '/prompts/p0016', '/prompts/p0018']);

        await tab.evaluate(PAGE.search, 'session 0346');               // 这条在第 4 页，还没加载
        await tab.waitFor(async () => visible(await tab.evaluate(PAGE.rows))[0] === '/prompts/p0346', { timeout: 25000, message: '后台取到第 4 页，命中那条很早的会话' });
        assert.deepStrictEqual(visible(await tab.evaluate(PAGE.rows)), ['/prompts/p0346']);

        // 关键字还在的时候，后台会把剩下的分页全部取完。
        const done = await tab.waitFor(async () => {
          const status = await tab.evaluate(PAGE.status);
          return status.kind === 'done' ? status : null;
        }, { timeout: 25000, message: '后台取完全部分页' });
        assert.equal(done.text, 'End of history');
        await tab.evaluate(() => document.querySelector('#aip-history .aip-search-clear').click());
        const restored = await tab.waitFor(async () => {
          const rows = await tab.evaluate(PAGE.rows);
          return rows.length === 350 && rows.every(row => !row.hidden) ? rows : null;
        }, { timeout: 4000, message: '清空关键字后 350 条全部可见' });
        assert.equal(restored.length, 350);
        assert.equal(await tab.evaluate(() => document.querySelector('#aip-history .aip-search-input').value), '');
      } finally {
        await tab.close();
      }
    });

    await test('历史流占用侧栏的弹性高度并独立滚动', async () => {
      const tab = await openChatPage();
      try {
        const layout = await tab.evaluate(() => {
          const nav = document.querySelector('ms-navbar-v2 .nav-content');
          const list = document.querySelector('.aip-history-scroll');
          return { overflow: nav.scrollHeight - nav.clientHeight, client: list.clientHeight, full: list.scrollHeight };
        });
        assert.ok(layout.overflow <= 1, `导航整体溢出 ${layout.overflow}px`);
        assert.ok(layout.full > layout.client, '历史流在自己的容器里滚动');
        assert.ok(layout.client >= 250, `历史流高度 ${layout.client}px`);
      } finally { await tab.close(); }
    });

    await test('新建、删除会话后侧栏自动同步 (无需刷新页面)', async () => {
      const tab = await openChatPage();
      try {
        await tab.evaluate(() => window.__app.rpc('CreatePrompt', JSON.stringify(['刚新建的会话']), () => {}));
        await tab.waitFor(async () => (await tab.evaluate(PAGE.rows))[0].title === '刚新建的会话', { timeout: 9000, message: '新建的会话出现在顶部' });
        assert.equal((await tab.evaluate(PAGE.rows)).length, 101);

        await tab.evaluate(() => window.__app.rpc('DeletePrompt', JSON.stringify('prompts/p0004'), () => {}));
        await tab.waitFor(async () => !(await tab.evaluate(PAGE.rows)).some(row => row.href === '/prompts/p0004'), { timeout: 9000, message: '删除的会话从侧栏消失' });
        assert.equal((await tab.evaluate(PAGE.rows)).length, 100);
        const lists = extensionLists(fixture);
        assert.ok(lists.length >= 2 && lists.every(entry => entry.body[0] === 100 && entry.body.length === 1), '每次都是重新同步首页');
      } finally {
        await tab.close();
      }
    });

    await test('滚动锚点：列表顶部插入新会话时，正在看的位置不跳动', async () => {
      const tab = await openChatPage();
      try {
        await tab.evaluate(PAGE.toBottom);
        await waitRows(tab, 200);
        await tab.evaluate(() => { document.querySelector('.aip-history-scroll').scrollTop = 1500; });
        await tab.evaluate(PAGE.settle);
        const before = await tab.evaluate(PAGE.topRow);
        assert.ok(before && before.href !== '/prompts/p0001', '确实滚到了列表中段');
        await tab.evaluate(() => window.__app.rpc('CreatePrompt', JSON.stringify(['插到最前面的会话']), () => {}));
        await tab.waitFor(async () => (await tab.evaluate(PAGE.rows))[0].title === '插到最前面的会话', { timeout: 9000 });
        await tab.evaluate(PAGE.settle);
        const after = await tab.evaluate(PAGE.topRow);
        assert.equal(after.href, before.href, '视口顶部还是同一行');
        assert.ok(Math.abs(after.offset - before.offset) <= 1, `位置只差 ${Math.abs(after.offset - before.offset)}px`);
      } finally {
        await tab.close();
      }
    });

    await test('侧栏收起时隐藏；深色主题下配色跟随站点', async () => {
      const tab = await openChatPage();
      try {
        const light = await tab.evaluate(() => getComputedStyle(document.querySelector('#aip-history .aip-row')).color);
        await tab.evaluate(() => document.body.classList.replace('light-theme', 'dark-theme'));
        const dark = await tab.evaluate(() => getComputedStyle(document.querySelector('#aip-history .aip-row')).color);
        assert.notEqual(light, dark);
        await tab.evaluate(() => document.querySelector('ms-navbar-v2 .nav-content').classList.replace('expanded', 'collapsed'));
        assert.equal(await tab.evaluate(() => getComputedStyle(document.querySelector('.aip-history')).display), 'none');
      } finally {
        await tab.close();
      }
    });

    await test('Voyager 节点保留在原位且不随抽屉隐藏', async () => {
      const tab = await openChatPage();
      try {
        await tab.evaluate(() => {
          const foreign = document.createElement('div');
          foreign.id = 'gv-test-panel';
          foreign.textContent = 'Voyager';
          document.querySelector('.aip-history').after(foreign);
        });
        await tab.waitFor(() => tab.evaluate(() => !!document.querySelector('#gv-test-panel')));
        const before = await tab.evaluate(() => ({
          hidden: getComputedStyle(document.querySelector('#gv-test-panel')).display === 'none',
          marked: document.querySelector('#gv-test-panel').classList.contains('aip-drawer-item')
        }));
        assert.deepEqual(before, { hidden: false, marked: false });
        await tab.evaluate(() => document.querySelector('.aip-drawer').click());
        assert.equal(await tab.evaluate(() => getComputedStyle(document.querySelector('#gv-test-panel')).display), 'block');
      } finally { await tab.close(); }
    });

    await test('导航被框架重建后，历史流自动补回来', async () => {
      const tab = await openChatPage();
      try {
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
        await waitRows(tab, 100);
        assert.equal(await tab.evaluate(() => document.querySelectorAll('#aip-history').length), 1, '不会出现第二份历史流');
        assert.equal(await tab.evaluate(() => document.querySelectorAll('.aip-drawer').length), 1, '抽屉手柄重新挂载');
      } finally {
        await tab.close();
      }
    });

    await test('无关页面不受影响', async () => {
      const tab = await open('/settings');
      try {
        await tab.waitFor(() => tab.evaluate(() => document.readyState === 'complete'));
        const touched = await tab.evaluate(() => ({
          title: document.title,
          history: !!document.querySelector('#aip-history'),
          drawer: !!document.querySelector('.aip-drawer')
        }));
        assert.deepStrictEqual(touched, { title: 'Settings', history: false, drawer: false });
        tab.assertNoErrors();
      } finally {
        await tab.close();
      }
    });

    await test('气泡模块回归 (tests/check.html)', async () => {
      const tab = await browser.newTab();
      try {
        await tab.goto(pathToFileURL(join(ROOT, 'tests', 'check.html')).href);
        const result = await tab.waitFor(() => tab.evaluate(() => {
          const text = document.getElementById('result').textContent;
          return /\n(PASS|FAIL)/.test(text) ? text : null;
        }), { timeout: 10000 });
        assert.ok(result.endsWith('PASS') && !result.includes('FAIL:'), result);
        assert.ok(result.split('\n').filter(line => line.startsWith('✓')).length >= 14, result);
      } finally {
        await tab.close();
      }
    });

    // 不认 world: "MAIN" 的浏览器 (如 Safari)：main.js 用 <script src> 兜底注入。
    const fallback = await Browser.launch({ executable: chromium, extensionDir: stageExtension({ mainWorld: false }) });
    browsers.push(fallback);
    // 兜底注入的两条用例不开主浏览器，也要从干净的服务器状态开始。
    const openIn = async (instance, path) => {
      fixture.reset();
      const tab = await instance.newTab();
      await tab.goto(`${fixture.pageOrigin}${path}`);
      return tab;
    };

    await test('兜底注入：拦截器在页面发出首页请求之前就位', async () => {
      const tab = await openIn(fallback, '/?slow=1200');
      try {
        const rows = await waitRows(tab, 100, 15000);
        assert.equal(await tab.evaluate(() => document.documentElement.hasAttribute('data-aip-interceptor')), true);
        assert.equal(rows[0].href, '/prompts/p0001');
      } finally {
        await tab.close();
      }
    });

    await test('兜底注入晚了一步、错过了页面的首页请求：稍后自己补取一次', async () => {
      const tab = await openIn(fallback, '/');
      try {
        await waitRows(tab, 100, 20000);
        const lists = extensionLists(fixture);
        assert.equal(lists.length, 1);
        assert.deepStrictEqual(lists[0].body, [100]);
      } finally {
        await tab.close();
      }
    });
  } finally {
    for (const instance of browsers) await instance.close();
    await fixture.close();
  }

  return suite.summary();
}

let ok = false;
try {
  ok = await main();
} finally {
  for (const dir of stagedDirs) rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
