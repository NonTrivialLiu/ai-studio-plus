import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, APP_HEADERS, appList, createWorld, installFetch, installXhr, page, plain, record, setupStack } from './harness.mjs';

const LIST = `${API}/ListPrompts`;
const FRESH_AUTH = 'SAPISIDHASH 2_def';
const recordOf = (id, title, seconds) => record({ id, title, seconds });
const withAuth = authorization => ({ ...APP_HEADERS, Authorization: authorization });

// 页面已经加载完首页、也过了静置期：接下来仓库的 loadMore 会直接触发代取。
async function loaded(stack) {
  appList(stack.world).reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));
  await stack.world.settle();
  await stack.world.clock.tick(4000);
  return stack;
}

// ---- 挂钩与识别 -------------------------------------------------------------------------------

test('在页面主世界里挂钩，并留下 DOM 标记', async () => {
  const world = createWorld();
  installXhr(world);
  const origSend = world.window.XMLHttpRequest.prototype.send;
  installFetch(world, async () => ({ status: 200, text: page([recordOf('b', 'Beta', 5)]) }));
  const origFetch = world.window.fetch;
  world.load('protocol.js', 'prompts-parser.js', 'interceptor.js');
  await world.settle();

  assert.equal(world.window.document.documentElement.attributes.get('data-aip-interceptor'), '1');
  assert.notEqual(world.window.XMLHttpRequest.prototype.send, origSend, 'XMLHttpRequest.send 已被替换');
  assert.notEqual(world.window.fetch, origFetch, 'fetch 已被替换');

  appList(world).reply(200, page([recordOf('a', 'Alpha', 10)]));
  await world.window.fetch(LIST, { method: 'POST', headers: APP_HEADERS, body: '[100]' });
  await world.settle();
  assert.deepStrictEqual(
    plain(world.of(world.window.AIPProtocol.PAGE).map(d => d.payload.items.map(x => x.id))),
    [['a'], ['b']]
  );
});

test('被注入到扩展世界时既不挂钩也不打标记 (留给兜底注入)', () => {
  const world = createWorld();
  installXhr(world);
  world.window.chrome = { runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' } };
  world.load('protocol.js', 'prompts-parser.js', 'interceptor.js');
  assert.equal(world.window.document.documentElement.hasAttribute('data-aip-interceptor'), false);
  const xhr = appList(world);
  xhr.reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));
  assert.equal(xhr.handlers.loadend, undefined, '没有读取响应');
});

test('重复注入 (manifest 注入与兜底注入先后到达) 不会重复发布', async () => {
  const { world, pages } = await setupStack();
  world.load('interceptor.js');
  appList(world).reply(200, page([recordOf('a', 'Alpha', 10)]));
  await world.settle();
  assert.equal(pages().length, 1);
});

test('挂钩对页面透明：原方法的参数、返回值与状态读取都不变', async () => {
  const { world } = await setupStack();
  const xhr = new world.window.XMLHttpRequest();
  assert.equal(xhr.open('POST', 'https://example.com/anything'), 'open-return');
  xhr.setRequestHeader('X-A', '1');
  assert.equal(xhr.setRequestHeader('X-A', '2'), undefined);
  assert.equal(xhr.headers['X-A'], '1, 2');
  assert.equal(xhr.send('payload'), undefined);
  assert.equal(xhr.body, 'payload');
  assert.equal(xhr.method, 'POST');
});

// ---- 读取页面的 ListPrompts 响应 ---------------------------------------------------------------

test('页面自己的首页 → replace；带游标的追加页 → append；只转发 id / 标题 / 更新时间', async () => {
  const stack = await setupStack();
  appList(stack.world).reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));
  appList(stack.world, { body: '[100,\"tok-2"]' }).reply(200, page([recordOf('b', 'Beta', 5)]));
  await stack.world.settle();
  assert.deepStrictEqual(stack.pages(), [
    { mode: 'replace', items: [{ id: 'a', title: 'Alpha', updatedAt: 10050 }], hasMore: true, unrecognized: 0, requestId: null },
    { mode: 'append', items: [{ id: 'b', title: 'Beta', updatedAt: 5050 }], hasMore: false, unrecognized: 0, requestId: null }
  ]);
  const wire = JSON.stringify(stack.pages());
  assert.equal(wire.includes('Someone'), false, '作者、头像等信息不跨世界');
  assert.equal(wire.includes('promptType'), false, '标签信息不跨世界');
  assert.equal(wire.includes('example.invalid'), false, '头像地址不跨世界');
});

test('请求体认不出时 (例如二进制)，按"手里是否有待取的游标"推断是首页还是追加页', async () => {
  const { world, pages } = await setupStack();
  appList(world).reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));
  appList(world, { body: new Uint8Array([1, 2, 3]) }).reply(200, page([recordOf('b', 'Beta', 5)]));
  await world.settle();
  assert.deepStrictEqual(pages().map(data => data.mode), ['replace', 'append']);
});

test('服务名前是句点 (线上形态) 还是斜杠都能认出来；版本号变化也不受影响', async () => {
  const { world, pages } = await setupStack();
  const shapes = [
    '/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts',   // 2026-11 线上实测
    '/$rpc/google.internal.alkali.applications.makersuite.v1/MakerSuiteService/ListPrompts',
    '/$rpc/google.internal.alkali.applications.makersuite.v2alpha.MakerSuiteService/ListPrompts'
  ];
  for (const shape of shapes) {
    appList(world, { url: 'https://alkalimakersuite-pa.clients6.google.com' + shape }).reply(200, page([recordOf('x', 'X', 1)]));
  }
  await world.settle();
  assert.equal(pages().length, shapes.length);
  for (const shape of shapes) {
    appList(world, { url: 'https://example.com' + shape.replace('MakerSuiteService', 'OtherService') }).reply(200, page([recordOf('x', 'X', 1)]));
  }
  await world.settle();
  assert.equal(pages().length, shapes.length, '服务名对不上的仍然不算');
});

test('无关请求不产生会话数据：其它接口、路径相似但不是 ListPrompts、别的站点', async () => {
  const { world, pages, errors } = await setupStack();
  for (const url of [`${API}/GetPrompt`, `${API}/GenerateContent`, `${API}/ListPromptsExtra`, `${LIST}ing`, 'https://example.com/ListPrompts']) {
    appList(world, { url }).reply(200, page([recordOf('x', 'X', 1)], 'tok'));
  }
  await world.settle();
  assert.equal(pages().length, 0);
  assert.equal(errors().length, 0);
});

test('页面请求失败或响应为空时不发布任何数据；响应认不出时给出 unparseable', async () => {
  const { world, pages, errors } = await setupStack();
  appList(world).reply(401, page([recordOf('x', 'X', 1)]));
  appList(world).reply(204, '');
  appList(world).reply(200, '  ');
  await world.settle();
  assert.equal(pages().length, 0);
  assert.equal(errors().length, 0);
  appList(world).reply(200, '<html>oops</html>');
  await world.settle();
  assert.deepStrictEqual(errors(), [{ code: 'unparseable', requestId: null }]);
});

test('其它接口请求里的 Authorization 会用来给样板保鲜，其余请求头保持页面原样', async () => {
  const stack = await setupStack({ fetchResponder: async () => ({ status: 200, text: page([recordOf('b', 'Beta', 1)]) }) });
  await loaded(stack);
  appList(stack.world, { url: `${API}/GetLoggingContext`, body: '[]', headers: withAuth(FRESH_AUTH) }).reply(401, '');
  stack.store.loadMore();
  await stack.world.settle();
  assert.equal(stack.fetches.length, 1);
  assert.equal(stack.fetches[0].headers.authorization, FRESH_AUTH, '鉴权头取最新的');
  assert.equal(stack.fetches[0].headers['x-goog-api-key'], APP_HEADERS['X-Goog-Api-Key']);
  assert.equal(stack.fetches[0].headers['x-user-agent'], APP_HEADERS['X-User-Agent']);
});

// ---- 代取分页 ---------------------------------------------------------------------------------

test('代取下一页：地址、请求头、每页条数、游标与凭据都沿用页面自己的请求', async () => {
  const stack = await setupStack({
    fetchResponder: async call => ({
      status: 200,
      text: call.body === '[50,\"tok-2"]' ? page([recordOf('b', 'Beta', 5)], 'tok-3') : page([recordOf('c', 'Gamma', 1)])
    })
  });
  appList(stack.world, { body: '[50]' }).reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));
  await stack.world.settle();
  await stack.world.clock.tick(4000);
  stack.store.loadMore();
  await stack.world.settle();

  assert.equal(stack.fetches.length, 1);
  assert.deepStrictEqual(
    plain({ url: stack.fetches[0].url, method: stack.fetches[0].method, body: stack.fetches[0].body, credentials: stack.fetches[0].credentials }),
    { url: LIST, method: 'POST', body: '[50,\"tok-2"]', credentials: 'include' }
  );
  assert.equal(stack.fetches[0].headers.authorization, APP_HEADERS.Authorization);
  assert.equal(stack.fetches[0].hasSignal, true, '带超时，网络卡死时不会永远挂着');
  assert.deepStrictEqual(stack.pages().slice(-1), [{
    mode: 'append', items: [{ id: 'b', title: 'Beta', updatedAt: 5050 }], hasMore: true, unrecognized: 0, requestId: 'r1'
  }]);

  stack.store.loadMore();
  await stack.world.settle();
  assert.equal(stack.fetches[1].body, '[50,\"tok-3"]');
  assert.deepStrictEqual(stack.pages().slice(-1).map(data => [data.hasMore, data.requestId]), [[false, 'r2']]);

  stack.store.loadMore();
  await stack.world.settle();
  assert.equal(stack.fetches.length, 2, '到底后仓库不再请求');
});

test('重新同步首页：首页没变时保留更深的游标，不重翻已经取过的页', async () => {
  const first = page([recordOf('a', 'Alpha', 10)], 'tok-2');
  const stack = await setupStack({
    fetchResponder: async call => ({ status: 200, text: call.body === '[100]' ? first : page([recordOf('b', 'Beta', 5)], 'tok-3') })
  });
  await loaded(stack);
  stack.store.loadMore();                   // 第二页
  await stack.world.settle();
  await stack.world.clock.tick(3000);       // 过刷新冷却
  stack.store.refresh();                    // 重新同步首页
  await stack.world.settle();
  stack.store.loadMore();                   // 接着往下：应从第三页继续，而不是重取第二页
  await stack.world.settle();
  assert.deepStrictEqual(stack.fetches.map(call => call.body), ['[100,\"tok-2"]', '[100]', '[100,\"tok-3"]']);
});

test('首页变了 (新建、删除或旧会话有了新活动) 时，游标回到第二页重新对齐', async () => {
  const stack = await setupStack({
    fetchResponder: async call => ({ status: 200, text: call.body === '[100]' ? page([recordOf('a', 'Alpha', 10)], 'tok-2') : page([recordOf('b', 'Beta', 5)]) })
  });
  await loaded(stack);
  stack.store.loadMore();
  await stack.world.settle();
  await stack.world.clock.tick(3000);
  appList(stack.world).reply(200, page([recordOf('a', 'Alpha', 10), recordOf('new', 'New', 11)], 'tok-2b'));   // 页面自己刷新了首页
  await stack.world.settle();
  await stack.world.clock.tick(4000);     // 过页面静置期
  stack.store.loadMore();
  await stack.world.settle();
  assert.deepStrictEqual(stack.fetches.map(call => call.body), ['[100,\"tok-2"]', '[100,\"tok-2b"]']);
});

test('没有样板时如实回复 no-template；之后可由同网关的其它请求推出样板', async () => {
  const stack = await setupStack({ fetchResponder: async () => ({ status: 200, text: page([recordOf('a', 'Alpha', 10)]) }) });
  stack.store.refresh();
  await stack.world.settle();
  assert.deepStrictEqual(stack.errors(), [{ code: 'no-template', requestId: 'r1' }]);
  assert.equal(stack.fetches.length, 0);

  appList(stack.world, { url: `${API}/GetUserPreferences`, body: '[]' }).reply(200, '[]');
  await stack.world.clock.tick(3000);       // 过刷新冷却
  stack.store.refresh();
  await stack.world.settle();
  assert.equal(stack.fetches.length, 1);
  assert.equal(stack.fetches[0].url, LIST, '由同网关的其它请求推出 ListPrompts 的地址');
  assert.equal(stack.fetches[0].body, '[100]');
  assert.equal(stack.fetches[0].headers.authorization, APP_HEADERS.Authorization);
  assert.deepStrictEqual(stack.pages().map(data => [data.mode, data.requestId]), [['replace', 'r2']]);
});

test('代取失败的分类：登录过期 / 服务端错误 / 响应认不出 / 网络异常', async () => {
  const cases = [
    [{ status: 401, text: '' }, 'unauthorized'],
    [{ status: 403, text: '' }, 'unauthorized'],
    [{ status: 500, text: '' }, 'http'],
    [{ status: 429, text: '' }, 'rate-limited'],
    [{ status: 404, text: '' }, 'not-found'],
    [{ status: 200, text: '<html>' }, 'unparseable'],
    [new TypeError('Failed to fetch'), 'network']
  ];
  for (const [reply, code] of cases) {
    const stack = await setupStack({
      fetchResponder: async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      }
    });
    await loaded(stack);
    stack.store.loadMore();
    await stack.world.settle();
    assert.deepStrictEqual(stack.errors(), [{ code, requestId: 'r1' }], code);
    assert.equal(stack.store.getView().loading, false, '失败后在途状态归零');
    assert.equal(stack.pages().length, 1, '失败不产生会话数据');
  }
});

test('循环保护：游标原地踏步或连续空页时按"到底"处理', async () => {
  const stuck = await setupStack({
    fetchResponder: async call => ({ status: 200, text: page([recordOf('x', 'X', 1)], JSON.parse(call.body)[1]) })
  });
  await loaded(stuck);
  stuck.store.loadMore();
  await stuck.world.settle();
  assert.equal(stuck.pages().slice(-1)[0].hasMore, false, '服务端反复返回同一个游标');
  stuck.store.loadMore();
  await stuck.world.settle();
  assert.equal(stuck.fetches.length, 1);

  let cursors = 0;
  const empty = await setupStack({ fetchResponder: async () => ({ status: 200, text: page([], `t${++cursors}`) }) });
  await loaded(empty);
  for (let i = 0; i < 5; i++) {
    empty.store.loadMore();
    await empty.world.settle();
  }
  assert.deepStrictEqual(empty.pages().slice(-3).map(data => data.hasMore), [true, true, false]);
  assert.equal(empty.fetches.length, 3, '连续三个空页后停止');
});

test('限速兜底：每分钟最多代发 60 次，超出的请求如实拒绝，一分钟后恢复', async () => {
  const stack = await loaded(await setupStack({ fetchResponder: async () => ({ status: 200, text: page([recordOf('x', 'X', 1)]) }) }));
  for (let i = 0; i < 61; i++) stack.send(stack.protocol.REQUEST, { requestId: `q${i}`, kind: 'next' });
  await stack.world.settle();
  assert.equal(stack.fetches.length, 60);
  assert.deepStrictEqual(stack.errors().slice(-1), [{ code: 'rate-limited', requestId: 'q60' }]);
  stack.send(stack.protocol.REQUEST, { requestId: 'again', kind: 'next' });
  await stack.world.settle();
  assert.equal(stack.fetches.length, 60, '窗口内持续拒绝');
  await stack.world.clock.tick(60001);
  stack.send(stack.protocol.REQUEST, { requestId: 'later', kind: 'next' });
  await stack.world.settle();
  assert.equal(stack.fetches.length, 61);
});

test('页面自己正在取下一页时，代取请求等它返回，并用页面刚送来的游标', async () => {
  const stack = await loaded(await setupStack({ fetchResponder: async () => ({ status: 200, text: page([recordOf('last', 'Last', 1)]) }) }));
  const inflight = appList(stack.world, { body: '[100,\"tok-2"]' });
  stack.send(stack.protocol.REQUEST, { requestId: 'q1', kind: 'next' });
  await stack.world.settle();
  assert.equal(stack.fetches.length, 0, '页面的请求还在途，先不发');
  inflight.reply(200, page([recordOf('p2', 'Page two', 5)], 'tok-3'));
  await stack.world.settle();
  assert.equal(stack.fetches.length, 1);
  assert.equal(stack.fetches[0].body, '[100,\"tok-3"]');
});

// ---- 失效通知、路由、就绪握手 ------------------------------------------------------------------

test('会话被新建 / 改名 / 删除后防抖通知；页面自己随即重新拉取时不再打扰；失败的请求不算', async () => {
  const { world } = await setupStack();
  const mutate = (name, status = 200) => appList(world, { url: `${API}/${name}`, body: '[]' }).reply(status, '[]');
  mutate('CreatePrompt');
  await world.clock.tick(500);
  mutate('UpdatePrompt');
  mutate('DeletePrompt', 500);
  await world.clock.tick(1499);
  assert.equal(world.of('prompts:invalidated').length, 0);
  await world.clock.tick(1);
  assert.deepStrictEqual(plain(world.of('prompts:invalidated').map(data => data.payload)), [{ reason: 'update' }]);

  mutate('DeletePrompt');
  await world.clock.tick(100);
  appList(world).reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));   // History 页删除后自己刷新了列表
  await world.clock.tick(2000);
  assert.equal(world.of('prompts:invalidated').length, 1, '页面已经刷新过，不再通知');
});

test('路由变化通知：路径或查询串变了才发；history 的原行为不变', async () => {
  const { world } = await setupStack();
  const history = world.window.history;
  assert.equal(history.pushState({ page: 1 }, '', '/prompts/abc'), undefined);
  history.pushState({}, '', '/prompts/abc');
  history.replaceState({}, '', '/library?x=1');
  history.replaceState({}, '', '/library?x=1');
  history.replaceState({}, '', '/library?x=2');
  await world.settle();
  assert.deepStrictEqual(plain(world.of('route:changed').map(data => data.payload)), [
    { path: '/prompts/abc' }, { path: '/library?x=1' }, { path: '/library?x=2' }
  ]);
  assert.equal(world.window.location.pathname, '/library');
  assert.deepEqual(plain(history.state), {});
});

test('兜底注入晚到：收到就绪信号后先等页面自己的首页，等不到再用自己的样板补取', async () => {
  const stack = await setupStack({ fetchResponder: async () => ({ status: 200, text: page([recordOf('a', 'Alpha', 10)]) }) });
  appList(stack.world, { url: `${API}/GetUserPreferences`, body: '[]' }).reply(200, '[]');
  stack.store.hello();
  await stack.world.settle();
  assert.equal(stack.fetches.length, 0, '不抢在页面前面');
  await stack.world.clock.tick(7999);
  assert.equal(stack.fetches.length, 0);
  await stack.world.clock.tick(1);
  assert.equal(stack.fetches.length, 1);
  assert.deepStrictEqual(stack.pages().map(data => [data.mode, data.requestId]), [['replace', null]]);

  const before = stack.pages().length;
  stack.store.hello();
  await stack.world.settle();
  assert.equal(stack.pages().length, before + 1, '手里已有首页时，就绪信号会触发重放');
});

test('等待期已过、页面恰在此刻自己取首页：不抢在它前面，直接用页面送来的结果', async () => {
  const stack = await setupStack({ fetchResponder: async () => ({ status: 200, text: page([recordOf('own', 'Own fetch', 10)]) }) });
  await stack.world.clock.tick(9000);                 // 等待期已过，只是还没有可用的样板
  const inflight = appList(stack.world, { body: '[100]' });
  await stack.world.settle();
  assert.equal(stack.fetches.length, 0, '页面的请求在途，扩展不发');
  inflight.reply(200, page([recordOf('page', 'From page', 10)], 'tok-2'));
  await stack.world.settle();
  assert.equal(stack.fetches.length, 0);
  assert.deepStrictEqual(stack.pages().map(data => data.items[0].id), ['page']);
});

test('等待期已过、页面自己的那次首页请求失败了：扩展接手补取', async () => {
  const stack = await setupStack({ fetchResponder: async () => ({ status: 200, text: page([recordOf('own', 'Own fetch', 10)]) }) });
  await stack.world.clock.tick(9000);
  const inflight = appList(stack.world, { body: '[100]' });
  await stack.world.settle();
  inflight.reply(500, '');
  await stack.world.settle();
  assert.equal(stack.fetches.length, 1);
  assert.deepStrictEqual(stack.pages().map(data => [data.items[0].id, data.requestId]), [['own', null]]);
});

test('页面在等待期内自己送来了首页：不再补取', async () => {
  const stack = await setupStack({ fetchResponder: async () => ({ status: 200, text: page([recordOf('own', 'Own fetch', 10)]) }) });
  await stack.world.clock.tick(3000);
  appList(stack.world).reply(200, page([recordOf('page', 'From page', 10)]));
  await stack.world.clock.tick(10000);
  await stack.world.settle();
  assert.equal(stack.fetches.length, 0);
  assert.deepStrictEqual(stack.pages().map(data => data.items[0].id), ['page']);
});

// ---- fetch 传输 -------------------------------------------------------------------------------

test('页面改用 fetch 调 ListPrompts 时同样被读取，调用方拿到的响应不受影响', async () => {
  const first = page([recordOf('a', 'Alpha', 10)], 'tok-2');
  const second = page([recordOf('b', 'Beta', 5)]);
  const { world, pages } = await setupStack({
    fetchResponder: async call => ({ status: 200, text: call.body === '[100]' ? first : second })
  });
  const response = await world.window.fetch(LIST, { method: 'POST', headers: APP_HEADERS, body: '[100]' });
  assert.equal(await response.text(), first, '调用方读到的正文完好');
  await world.settle();
  assert.deepStrictEqual(pages().map(data => data.mode), ['replace']);

  await world.window.fetch(new Request(LIST, { method: 'POST', headers: APP_HEADERS, body: '[100,\"tok-2"]' }));
  await world.settle();
  assert.deepStrictEqual(pages().map(data => data.mode), ['replace', 'append']);
});

// ---- 改名 / 复制 / 删除 --------------------------------------------------------------------------

// 完整会话 (ResolveDriveResource 的响应)：比列表记录多了第 4 个字段 (模型配置)。
function fullPrompt(id, title) {
  const full = record({ id, title, seconds: 100 });
  full[3] = [42];
  return JSON.stringify([full]);
}

function actionResponder(seen, reply) {
  return async call => {
    const method = call.url.split('/').pop();
    seen.push({ method, body: JSON.parse(call.body) });
    return reply(method);
  };
}

test('改名：先取完整会话，再把改了标题的完整对象整体提交；成功后通知重新同步', async () => {
  const seen = [];
  const stack = await setupStack({ fetchResponder: actionResponder(seen, method => ({ status: 200, text: method === 'ResolveDriveResource' ? fullPrompt('abc', 'Old title') : '[]' })) });
  await loaded(stack);
  stack.send(stack.protocol.ACTION, { requestId: 'a1', action: 'rename', id: 'abc', title: '  New   title ' });
  await stack.world.settle();
  assert.deepStrictEqual(seen.map(x => x.method), ['ResolveDriveResource', 'UpdatePrompt']);
  assert.deepStrictEqual(plain(seen[0].body), ['abc'], 'ResolveDriveResource 的请求体就是 ["<id>"]');
  const record1 = seen[1].body[0];
  assert.deepStrictEqual(plain([record1[0], record1[4][0], record1[3]]), ['prompts/abc', 'New title', [42]], '提交的是带模型配置的完整对象，标题已改，多余空白已收起');
  assert.ok(stack.fetches.every(call => call.credentials === 'include' && call.hasSignal), '两个请求都带凭据与超时');
  assert.deepStrictEqual(plain(stack.world.of('action:result').map(data => data.payload)), [{ requestId: 'a1', action: 'rename', ok: true }]);
  assert.equal(stack.world.of('prompts:invalidated').length, 1, '马上通知列表重新同步');
});

test('改名后页面若带着旧标题自己提交 UpdatePrompt (XHR 与 fetch)，发出前会被换成新标题', async () => {
  const seen = [];
  const stack = await setupStack({ fetchResponder: actionResponder(seen, method => ({ status: 200, text: method === 'ResolveDriveResource' ? fullPrompt('abc', 'Old title') : '[]' })) });
  await loaded(stack);
  stack.send(stack.protocol.ACTION, { requestId: 'a1', action: 'rename', id: 'abc', title: 'New title' });
  await stack.world.settle();
  seen.length = 0;

  const viaXhr = appList(stack.world, { url: `${API}/UpdatePrompt`, headers: APP_HEADERS, body: fullPrompt('abc', 'Old title') });
  assert.equal(JSON.parse(viaXhr.body)[0][4][0], 'New title', 'XHR：发出的是新标题');
  viaXhr.reply(200, '[]');

  await stack.world.window.fetch(`${API}/UpdatePrompt`, { method: 'POST', headers: APP_HEADERS, body: fullPrompt('abc', 'Old title') });
  await stack.world.settle();
  assert.equal(seen[0].body[0][4][0], 'New title', 'fetch：发出的是新标题');
  assert.deepStrictEqual(seen[0].body[0][3], [42], '请求体里其余内容原样保留');
});

test('页面自己又把标题改成别的值时放行，并撤掉保护', async () => {
  const seen = [];
  const stack = await setupStack({ fetchResponder: actionResponder(seen, method => ({ status: 200, text: method === 'ResolveDriveResource' ? fullPrompt('abc', 'Old title') : '[]' })) });
  await loaded(stack);
  stack.send(stack.protocol.ACTION, { requestId: 'a1', action: 'rename', id: 'abc', title: 'New title' });
  await stack.world.settle();

  const official = appList(stack.world, { url: `${API}/UpdatePrompt`, body: fullPrompt('abc', 'Even newer') });
  assert.equal(JSON.parse(official.body)[0][4][0], 'Even newer', '官方界面改的名字不被覆盖');
  official.reply(200, '[]');

  const later = appList(stack.world, { url: `${API}/UpdatePrompt`, body: fullPrompt('abc', 'Old title') });
  assert.equal(JSON.parse(later.body)[0][4][0], 'Old title', '保护已撤：之后页面发什么就是什么');
});

test('复制：取完整会话 → 清空资源名 → 标题 "Copy of …" → 按新建提交', async () => {
  const seen = [];
  const stack = await setupStack({ fetchResponder: actionResponder(seen, method => ({ status: 200, text: method === 'ResolveDriveResource' ? fullPrompt('abc', 'A chat') : '[]' })) });
  await loaded(stack);
  stack.send(stack.protocol.ACTION, { requestId: 'c1', action: 'copy', id: 'abc', title: 'Copy of A chat' });
  await stack.world.settle();
  assert.deepStrictEqual(seen.map(x => x.method), ['ResolveDriveResource', 'CreatePrompt']);
  const copy = seen[1].body[0];
  assert.deepStrictEqual(plain([copy[0], copy[4][0], copy[3]]), ['', 'Copy of A chat', [42]]);
  assert.deepStrictEqual(plain(stack.world.of('action:result').map(data => data.payload)), [{ requestId: 'c1', action: 'copy', ok: true }]);
});

test('复制的两次请求各自耗时较长时仍能返回最终结果', async () => {
  let stack;
  stack = await setupStack({ fetchResponder: async call => {
    await new Promise(resolve => stack.world.clock.setTimeout(resolve, 16000));
    return { status: 200, text: call.url.endsWith('/ResolveDriveResource') ? fullPrompt('abc', 'A chat') : '[]' };
  } });
  appList(stack.world).reply(200, page([recordOf('abc', 'A chat', 10)]));
  await stack.world.settle();
  stack.send(stack.protocol.ACTION, { requestId: 'slow-copy', action: 'copy', id: 'abc', title: 'Copy of A chat' });
  await stack.world.settle();
  await stack.world.clock.tick(16000);
  await stack.world.clock.tick(16000);
  await stack.world.settle();
  assert.deepStrictEqual(plain(stack.world.of('action:result').map(data => data.payload)), [{ requestId: 'slow-copy', action: 'copy', ok: true }]);
});

test('删除：DeletePrompt 的请求体只有会话名；成功后通知重新同步', async () => {
  const seen = [];
  const stack = await setupStack({ fetchResponder: actionResponder(seen, () => ({ status: 200, text: '[]' })) });
  await loaded(stack);
  stack.send(stack.protocol.ACTION, { requestId: 'd1', action: 'delete', id: 'abc' });
  await stack.world.settle();
  assert.deepStrictEqual(seen, [{ method: 'DeletePrompt', body: ['prompts/abc'] }]);
  assert.deepStrictEqual(plain(stack.world.of('action:result').map(data => data.payload)), [{ requestId: 'd1', action: 'delete', ok: true }]);
  assert.equal(stack.world.of('prompts:invalidated').length, 1);
});

test('页面在 Google Drive 文件夹里列出会话时，提交与删除都带上同一个文件夹', async () => {
  const seen = [];
  const stack = await setupStack({ fetchResponder: actionResponder(seen, method => ({ status: 200, text: method === 'ResolveDriveResource' ? fullPrompt('abc', 'T') : '[]' })) });
  appList(stack.world, { body: '[100, null, "folder-1"]' }).reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));
  await stack.world.settle();
  stack.send(stack.protocol.ACTION, { requestId: 'r1', action: 'rename', id: 'abc', title: 'New' });
  stack.send(stack.protocol.ACTION, { requestId: 'd1', action: 'delete', id: 'abc' });
  await stack.world.settle();
  // 改名要发两个请求，完成顺序不固定：按方法名排序后比较。
  assert.deepStrictEqual(
    plain(seen.map(x => [x.method, x.body.slice(1)]).sort((x, y) => x[0].localeCompare(y[0]))),
    [['DeletePrompt', ['folder-1']], ['ResolveDriveResource', []], ['UpdatePrompt', [null, 'folder-1']]]
  );
});

test('操作失败时如实回复原因，不发"列表变了"的通知；空白标题与非法 id 不会被提交', async () => {
  const seen = [];
  const stack = await setupStack({ fetchResponder: actionResponder(seen, method => ({ status: method === 'UpdatePrompt' ? 403 : 200, text: method === 'ResolveDriveResource' ? fullPrompt('abc', 'T') : '[]' })) });
  await loaded(stack);
  stack.send(stack.protocol.ACTION, { requestId: 'r1', action: 'rename', id: 'abc', title: 'New' });
  await stack.world.settle();
  assert.deepStrictEqual(plain(stack.world.of('action:result').map(data => data.payload)), [{ requestId: 'r1', action: 'rename', ok: false, code: 'unauthorized' }]);

  seen.length = 0;
  stack.send(stack.protocol.ACTION, { requestId: 'r2', action: 'rename', id: 'abc', title: '   ' });
  stack.send(stack.protocol.ACTION, { requestId: 'r3', action: 'rename', id: 'bad id', title: 'x' });
  stack.send(stack.protocol.ACTION, { requestId: 'r4', action: 'explode', id: 'abc' });
  await stack.world.settle();
  assert.deepStrictEqual(seen.map(x => x.method), ['ResolveDriveResource'], '空白标题在提交前就被拦下；非法 id 与未知操作什么都不发');
  assert.deepStrictEqual(plain(stack.world.of('action:result').map(data => [data.payload.requestId, data.payload.ok, data.payload.code])), [['r1', false, 'unauthorized'], ['r2', false, 'invalid']]);
  assert.equal(stack.world.of('prompts:invalidated').length, 0);
});

test('没有样板时执行 rename / copy / delete 返回 no-template，不发网络请求', async () => {
  const stack = await setupStack();
  stack.send(stack.protocol.ACTION, { requestId: 'n1', action: 'rename', id: 'abc', title: 'New' });
  stack.send(stack.protocol.ACTION, { requestId: 'n2', action: 'copy', id: 'abc', title: 'Copy' });
  stack.send(stack.protocol.ACTION, { requestId: 'n3', action: 'delete', id: 'abc' });
  await stack.world.settle();
  assert.equal(stack.fetches.length, 0);
  assert.deepStrictEqual(plain(stack.world.of('action:result').map(d => d.payload)), [
    { requestId: 'n1', action: 'rename', ok: false, code: 'no-template' },
    { requestId: 'n2', action: 'copy', ok: false, code: 'no-template' },
    { requestId: 'n3', action: 'delete', ok: false, code: 'no-template' }
  ]);
});

test('fetchPage 在 Google Drive 文件夹里代取下一页和刷新首页时保留 folder', async () => {
  const stack = await setupStack({
    fetchResponder: async () => ({ status: 200, text: page([recordOf('b', 'Beta', 5)]) })
  });
  appList(stack.world, { body: '[50, null, "folder-1"]' }).reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));
  await stack.world.settle();
  await stack.world.clock.tick(4000);
  stack.store.loadMore();
  await stack.world.settle();
  await stack.world.clock.tick(3000);
  stack.store.refresh();
  await stack.world.settle();
  assert.deepStrictEqual(stack.fetches.map(call => JSON.parse(call.body)), [
    [50, 'tok-2', 'folder-1'],
    [50, null, 'folder-1']
  ]);
});

test('页面用 fetch (Request 对象) 调 ListPrompts 时，异步读完请求体后学会 pageSize 与 folder', async () => {
  const first = page([recordOf('a', 'Alpha', 10)], 'tok-2');
  const second = page([recordOf('b', 'Beta', 5)]);
  const stack = await setupStack({
    fetchResponder: async call => ({ status: 200, text: call.body?.includes('tok-2') ? second : first })
  });
  await stack.world.window.fetch(new Request(LIST, { method: 'POST', headers: APP_HEADERS, body: '[25, null, "drive-dir"]' }));
  await stack.world.settle();
  await stack.world.clock.tick(4000);
  stack.store.loadMore();
  await stack.world.settle();
  assert.equal(stack.fetches.length, 2);
  assert.deepStrictEqual(JSON.parse(stack.fetches[1].body), [25, 'tok-2', 'drive-dir']);
});

test('请求超时触发 AbortError 时返回 timeout', async () => {
  const stack = await setupStack({
    fetchResponder: () => new Promise(() => {})
  });
  await loaded(stack);
  stack.send(stack.protocol.ACTION, { requestId: 'to1', action: 'delete', id: 'abc' });
  await stack.world.settle();
  await stack.world.clock.tick(20000);
  await stack.world.settle();
  assert.deepStrictEqual(plain(stack.world.of('action:result').map(d => d.payload)), [
    { requestId: 'to1', action: 'delete', ok: false, code: 'timeout' }
  ]);
});

test('在 Google Drive 文件夹里复制会话时 CreatePrompt 带上同一个文件夹', async () => {
  const seen = [];
  const stack = await setupStack({
    fetchResponder: actionResponder(seen, method => ({ status: 200, text: method === 'ResolveDriveResource' ? fullPrompt('abc', 'A chat') : '[]' }))
  });
  appList(stack.world, { body: '[100, null, "folder-1"]' }).reply(200, page([recordOf('a', 'Alpha', 10)], 'tok-2'));
  await stack.world.settle();
  stack.send(stack.protocol.ACTION, { requestId: 'c1', action: 'copy', id: 'abc', title: 'Copy of A chat' });
  await stack.world.settle();
  assert.deepStrictEqual(seen.map(x => x.method), ['ResolveDriveResource', 'CreatePrompt']);
  assert.deepStrictEqual(plain(seen[0].body), ['abc']);
  assert.equal(seen[1].body[1], 'folder-1');
  assert.equal(seen[1].body[0][0], '');
  assert.equal(seen[1].body[0][4][0], 'Copy of A chat');
});

test('历史已到底后，首页内容未变时重新同步不会把 hasMore 重新打开', async () => {
  const first = page([recordOf('a', 'Alpha', 10)], 'tok-2');
  const last = page([recordOf('b', 'Beta', 5)]);
  const stack = await setupStack({
    fetchResponder: async call => ({ status: 200, text: call.body === '[100]' ? first : last })
  });
  await loaded(stack);
  stack.store.loadMore();
  await stack.world.settle();
  assert.equal(stack.store.getView().hasMore, false);

  await stack.world.clock.tick(3000);
  stack.store.refresh();
  await stack.world.settle();
  assert.equal(stack.store.getView().hasMore, false, '首页未变且之前已到底，保持 hasMore = false');
  assert.equal(stack.store.loadMore(), false);
  assert.equal(stack.fetches.length, 2);
});
