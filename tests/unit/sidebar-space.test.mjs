import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './harness.mjs';

function setupSpace({ pageWidth = 1280, nodes = {} } = {}) {
  const world = createWorld();
  const makeNode = spec => {
    if (!spec) return null;
    const classes = new Set(spec.classes || []);
    return {
      classList: { contains: name => classes.has(name) },
      getBoundingClientRect: () => ({ width: spec.width ?? 0, height: spec.height ?? 900, left: 0, top: 0, right: spec.width ?? 0, bottom: spec.height ?? 900 }),
      __style: { position: spec.position || 'static' }
    };
  };
  const resolved = Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, makeNode(v)]));
  world.window.document.documentElement.clientWidth = pageWidth;
  world.window.document.querySelector = selector => resolved[selector] || null;
  world.window.getComputedStyle = node => node?.__style || { position: 'static' };
  world.load('sidebar-space.js');
  return world.window.AIPSidebarSpace;
}

test('COMPACT_WIDTH 640px 边界判断', () => {
  assert.equal(setupSpace({ pageWidth: 640 }).canPreview('left', 100), false, '恰好 640px 禁止悬浮预览');
  assert.equal(setupSpace({ pageWidth: 639 }).canPreview('left', 100), false, '小于 640px 禁止悬浮预览');
  assert.equal(setupSpace({ pageWidth: 641 }).canPreview('left', 240), true, '641px 且剩余 >= 400px 允许预览');
  assert.equal(setupSpace({ pageWidth: 641 }).canPreview('left', 242), false, '641 - 242 = 399 < 400 不允许预览');
});

test('左右侧栏悬浮预览互斥 (.aip-peek / .aip-run-peek)', () => {
  const leftPeekActive = setupSpace({
    pageWidth: 1280,
    nodes: { '.nav-content.aip-peek': { classes: ['nav-content', 'aip-peek'], width: 240 } }
  });
  assert.equal(leftPeekActive.canPreview('right', 300), false, '左栏正在预览时右栏禁止自动预览');

  const rightPeekActive = setupSpace({
    pageWidth: 1280,
    nodes: { '.aip-run-peek': { classes: ['aip-run-peek'], width: 0 } }
  });
  assert.equal(rightPeekActive.canPreview('left', 240), false, '右栏正在预览时左栏禁止自动预览');
});

test('原生固定覆盖模式下禁止悬浮预览', () => {
  const fixedLeft = setupSpace({
    pageWidth: 1280,
    nodes: { 'ms-navbar-v2 .nav-content': { position: 'fixed', width: 240 } }
  });
  assert.equal(fixedLeft.canPreview('left', 240), false);
  assert.equal(fixedLeft.canPreview('right', 300), false);

  const fixedRight = setupSpace({
    pageWidth: 1280,
    nodes: { 'ms-right-side-panel': { position: 'fixed', width: 300 } }
  });
  assert.equal(fixedRight.canPreview('left', 240), false);
  assert.equal(fixedRight.canPreview('right', 300), false);
});

test('.layout-main 宽度夹紧与对侧栏占用空间扣除', () => {
  const clamped = setupSpace({
    pageWidth: 1280,
    nodes: { '.layout-main': { width: 600 } }
  });
  assert.equal(clamped.canPreview('left', 240), false, '600 - 240 = 360 < 400 被 .layout-main 夹紧拒绝');
  assert.equal(clamped.canPreview('left', 200), true, '600 - 200 = 400 >= 400 允许');

  const withOpposite = setupSpace({
    pageWidth: 1000,
    nodes: {
      'ms-right-side-panel': { width: 300 },
      '.layout-main': { width: 900 }
    }
  });
  assert.equal(withOpposite.canPreview('left', 301), false, '1000 - 300 - 301 = 399 < 400');
  assert.equal(withOpposite.canPreview('left', 300), true, '1000 - 300 - 300 = 400 >= 400');
});

test('containsPointer 边界与异常值判断', () => {
  const space = setupSpace();
  const rect = { left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 };
  assert.equal(space.containsPointer(rect, 10, 20), true, '左上角包含');
  assert.equal(space.containsPointer(rect, 109.9, 69.9), true, '内部点包含');
  assert.equal(space.containsPointer(rect, 110, 20), false, '右边界不包含');
  assert.equal(space.containsPointer(rect, 10, 70), false, '下边界不包含');
  assert.equal(space.containsPointer(rect, 9, 30), false);
  assert.equal(space.containsPointer(null, 20, 30), false);
  assert.equal(space.containsPointer({ ...rect, width: 0 }, 10, 20), false);
  assert.equal(space.containsPointer({ ...rect, height: 0 }, 10, 20), false);
  assert.equal(space.containsPointer(rect, NaN, 30), false);
  assert.equal(space.containsPointer(rect, 20, Infinity), false);
  assert.equal(space.OPEN_DELAY, 300);
  assert.equal(space.CLOSE_DELAY, 250);
});
