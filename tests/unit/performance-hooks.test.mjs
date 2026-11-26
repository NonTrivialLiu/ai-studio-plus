import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT, createClock } from './harness.mjs';

test('performance.css、sidebar.css 与 nav-collapse.css 遵循低开销选择器与零残留坍缩规则', () => {
  const perfCss = readFileSync(join(ROOT, 'extension', 'styles', 'performance.css'), 'utf8');
  const sidebarCss = readFileSync(join(ROOT, 'extension', 'styles', 'sidebar.css'), 'utf8');
  const navCss = readFileSync(join(ROOT, 'extension', 'styles', 'nav-collapse.css'), 'utf8');

  assert.equal(/^\s*\*:/m.test(perfCss), false, '不得对全节点使用 *:not(...) 全局选择器');
  assert.equal(/\*\s*,\s*\*::before/m.test(perfCss), false, '不得对 * 与伪元素全局遍历 backdrop-filter');
  assert.equal(/ms-chat-turn[\s\S]*content-visibility/m.test(perfCss), false, '不在 ms-chat-turn 叠加 content-visibility 以免与站点虚拟滚动冲突');
  assert.match(sidebarCss, /\.aip-row\s*\{[^}]*content-visibility:\s*auto;\s*contain-intrinsic-block-size:\s*28px;/s);
  assert.match(navCss, /ms-navbar-v2:has\(>\s*\.nav-content\.collapsed:not\(\.aip-peek\)\)\s*\{[^}]*width:\s*0\s*!important;/s);
});

test('main.js 在 document_start 为缺失端点注入去重后的 preconnect 标签', () => {
  const src = readFileSync(join(ROOT, 'extension', 'src', 'main.js'), 'utf8');
  const existingPreconnect = {
    rel: 'preconnect',
    href: 'https://apis.google.com/',
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = v; }
  };
  const appended = [];
  const head = {
    appendChild(node) {
      appended.push(node);
      return node;
    }
  };
  const doc = {
    readyState: 'loading',
    head,
    body: null,
    documentElement: {
      hasAttribute: () => true,
      appendChild(node) { appended.push(node); return node; }
    },
    querySelectorAll(sel) {
      return sel.includes('preconnect') ? [existingPreconnect] : [];
    },
    createElement(tag) {
      return { tagName: tag.toUpperCase(), dataset: {}, rel: '', href: '', crossOrigin: '' };
    },
    addEventListener() {}
  };

  vm.runInNewContext(src, {
    URL,
    Set,
    location: { href: 'https://aistudio.google.com/prompts/new_chat' },
    document: doc,
    globalThis: {}
  });

  const hrefs = appended.map(el => el.href).sort();
  assert.deepStrictEqual(hrefs, [
    'https://people-pa.clients6.google.com',
    'https://waa-pa.clients6.google.com'
  ]);
  for (const el of appended) {
    assert.equal(el.rel, 'preconnect');
    assert.equal(el.crossOrigin, 'anonymous');
    assert.equal(el.dataset.aipPreconnect, '1');
  }
});

test('bubbles.js 屏蔽 model 流式容器、增量处理脏气泡并在正文滚动期间让路', async () => {
  const src = readFileSync(join(ROOT, 'extension', 'src', 'bubbles.js'), 'utf8');
  const clock = createClock();
  const observations = [];
  const docListeners = new Map();
  let rafQueue = [];

  class MockMutationObserver {
    constructor(cb) { this.cb = cb; }
    observe(target, opts) { observations.push({ observer: this, target, opts }); }
  }

  let scrollReads = 0;
  function makeTurn() {
    let turn = null;
    const content = {
      nodeType: 1,
      textContent: 'long user prompt',
      querySelector: () => null,
      closest: sel => {
        if (sel.includes('.aib-toggle')) return null;
        if (sel.includes('.user')) return turn;
        return null;
      },
      get scrollHeight() { scrollReads += 1; return 420; }
    };
    const prompt = {
      firstElementChild: null,
      querySelector: sel => sel === '.turn-content' ? content : null
    };
    const btn = {
      type: '', className: '', hidden: false, parentElement: null, textContent: '',
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener() {}
    };
    turn = {
      isConnected: true,
      attrs: new Set(),
      querySelector: sel => sel === '.user-prompt-container' ? prompt : null,
      querySelectorAll: () => [],
      toggleAttribute(k, v) { v ? this.attrs.add(k) : this.attrs.delete(k); },
      hasAttribute: k => turn.attrs.has(k),
      classList: { contains: cls => cls === 'render' },
      append(node) { node.parentElement = turn; btn.parentElement = turn; },
      closest: sel => sel.includes('.user') ? turn : null
    };
    return { turn, content };
  }

  const { turn: turn1, content: turn1Content } = makeTurn();
  const modelNode = { nodeType: 1, closest: sel => sel.includes('.model') ? modelNode : null, matches: () => false, querySelectorAll: () => [] };
  const addedModelText = { nodeType: 1, matches: () => false, querySelectorAll: () => [] };

  const ctx = {
    WeakMap, WeakSet, Set,
    MutationObserver: MockMutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: id => clock.clearTimeout(id),
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
    document: {
      body: { nodeName: 'BODY' },
      createElement: () => ({ type: '', className: '', hidden: false, style: {}, addEventListener() {}, setAttribute() {} }),
      querySelectorAll: sel => sel.includes('.user') ? [turn1] : [],
      addEventListener(type, fn, opts) { docListeners.set(type, { fn, opts }); }
    },
    globalThis: {}
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(src, ctx);

  ctx.AIPBubbles.init();
  assert.equal(scrollReads, 1);
  assert.equal(docListeners.get('scroll')?.opts?.passive, true);

  const turnObs = observations.find(o => o.target === turn1);
  const rootObs = observations.find(o => o.target === ctx.document.body);
  assert.ok(turnObs && turnObs.opts.characterData === true);
  assert.ok(rootObs && rootObs.opts.characterData !== true);

  // model 容器变动不调度刷新
  rootObs.observer.cb([{ target: modelNode, addedNodes: [addedModelText], removedNodes: [] }]);
  assert.equal(rafQueue.length, 0);

  // 主区域滚动中，用户气泡内容变更先记为脏并让路；滚动停顿 120ms 后才增量重测
  const scrollFn = docListeners.get('scroll').fn;
  scrollFn({ target: { closest: () => null } });
  turnObs.observer.cb([{ type: 'characterData', target: turn1Content, addedNodes: [], removedNodes: [] }]);
  assert.equal(rafQueue.length, 0, '主对话连续滚动期间延后调度 rAF');

  await clock.tick(120);
  assert.equal(rafQueue.length, 1, '滚动停顿 120ms 后触发一次增量冲洗');
  const pending = rafQueue.splice(0);
  for (const fn of pending) fn();
  assert.equal(scrollReads, 2, '仅在滚动停顿后重新测量脏 user 容器高度');

  // 侧栏自身滚动不得阻塞气泡更新
  scrollFn({ target: { closest: sel => sel === '#aip-history' ? {} : null } });
  ctx.AIPBubbles.schedule(turn1);
  assert.equal(rafQueue.length, 1, '侧栏 #aip-history 滚动不推迟气泡刷新');
});
