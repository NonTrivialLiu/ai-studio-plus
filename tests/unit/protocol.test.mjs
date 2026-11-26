import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, plain } from './harness.mjs';

const ORIGIN = 'https://aistudio.google.com';
const envelope = (type, payload, channel = 'aistudio-plus:v1') => ({ channel, type, payload });

// 模拟另一个脚本往本窗口发消息。
function post(world, data, { origin = ORIGIN, source } = {}) {
  world.window.dispatch('message', { data, origin, source: source || world.global });
}

test('send 发出带频道名的信封，且只投递给本源', async () => {
  const world = createWorld();
  world.load('protocol.js');
  const { send, PAGE } = world.window.AIPProtocol;
  send(PAGE, { mode: 'append' });
  await world.settle();
  assert.deepStrictEqual(plain(world.mailbox), [{ data: envelope(PAGE, { mode: 'append' }), origin: ORIGIN }]);
});

test('receive 只接受本窗口、同源、频道与类型都匹配、payload 为对象的信封', async () => {
  const world = createWorld();
  world.load('protocol.js');
  const { receive, PAGE, ERROR } = world.window.AIPProtocol;
  const seen = [];
  receive(PAGE, payload => seen.push(payload));

  post(world, envelope('some:other:type', { code: 'x' }));          // 没人订阅的类型
  post(world, envelope(ERROR, { code: 'x' }));                        // 类型不匹配
  post(world, envelope(PAGE, { code: 'x' }, 'other-channel'));        // 频道不匹配
  post(world, envelope(PAGE, { code: 'x' }), { origin: 'https://evil.example' });   // 跨源
  post(world, envelope(PAGE, { code: 'x' }), { source: {} });         // 不是本窗口
  post(world, envelope(PAGE, 'string'));                              // payload 不是对象
  post(world, { channel: 'aistudio-plus:v1', type: PAGE });           // 没有 payload
  post(world, null);
  post(world, 'aistudio-plus:v1');
  post(world, envelope(PAGE, { mode: 'append' }));                    // ✓
  post(world, { ...envelope(PAGE, { mode: 'replace' }), extra: 1 });  // ✓ 多出来的字段不影响
  await world.settle();

  assert.deepStrictEqual(plain(seen), [{ mode: 'append' }, { mode: 'replace' }]);
});

test('退订后不再收到消息', () => {
  const world = createWorld();
  world.load('protocol.js');
  const { receive, ROUTE } = world.window.AIPProtocol;
  const seen = [];
  const stop = receive(ROUTE, payload => seen.push(payload));
  post(world, envelope(ROUTE, { path: '/a' }));
  stop();
  post(world, envelope(ROUTE, { path: '/b' }));
  assert.deepStrictEqual(plain(seen), [{ path: '/a' }]);
});

test('两个世界的消息类型互不重叠', () => {
  const world = createWorld();
  world.load('protocol.js');
  const types = Object.values(world.window.AIPProtocol).filter(value => typeof value === 'string');
  assert.equal(new Set(types).size, types.length);
});
