import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, createWorld, plain } from './harness.mjs';

const NOW = new Date(2026, 10, 24, 12, 0, 0).getTime();     // 2026-11-24 本地时间正午
const DAY = 86400000;

// 用本地日历日造时间戳，测试与所在时区无关。
const at = (daysAgo, hour = 12, minute = 0) => new Date(2026, 10, 24 - daysAgo, hour, minute, 0).getTime();
const item = (id, updatedAt, title = `Title ${id}`) => ({ id, title, updatedAt });

// 只加载协议与仓库：数据由测试直接推送，模拟拦截器。
async function setup({ storage } = {}) {
  const world = createWorld({ clock: createClock(NOW) });
  if (storage) for (const [key, value] of storage) world.storage.set(key, value);
  world.load('protocol.js', 'history-store.js');
  await world.settle();
  const protocol = world.window.AIPProtocol;
  return {
    world,
    protocol,
    store: world.window.AIPHistoryStore,
    view: () => plain(world.window.AIPHistoryStore.getView()),
    groups: () => {
      const view = world.window.AIPHistoryStore.getView();
      return plain(view.groups.map(group => [group.label, group.items.map(entry => entry.id)]));
    },
    page: async payload => {
      protocol.send(protocol.PAGE, { mode: 'append', items: [], hasMore: false, requestId: null, ...payload });
      await world.settle();
    },
    error: async payload => {
      protocol.send(protocol.ERROR, { requestId: null, ...payload });
      await world.settle();
    },
    requests: () => plain(world.of(protocol.REQUEST).map(data => data.payload))
  };
}

test('初始状态：空、未同步，不会在拿到页面数据前自己发请求', async () => {
  const { store, view, world } = await setup();
  const { ids, pageEventAt, ...initial } = view();
  assert.deepStrictEqual(initial, { groups: [], total: 0, shown: 0, query: '', hasMore: true, loading: false, error: null, live: false });
  assert.equal(store.getView().ids.size, 0);
  assert.equal(pageEventAt, 0);
  assert.equal(store.loadMore(), false);
  assert.equal(store.noteCurrentPrompt('unknown'), undefined);
  await world.settle();
  assert.equal(world.of('prompts:request').length, 0);
  assert.equal(world.mailbox[0].data.type, 'hello');
});

test('按本地日历日分桶：Today / Yesterday / Previous 7 days / Previous 30 days / Earlier', async () => {
  const { page, groups } = await setup();
  await page({
    mode: 'replace',
    items: [
      item('today', at(0, 0, 5)),            // 今天凌晨也算今天
      item('yesterday', at(1, 23, 59)),
      item('days-ago-2', at(2)),
      item('days-ago-7', at(7)),
      item('days-ago-8', at(8)),
      item('days-ago-30', at(30)),
      item('days-ago-31', at(31)),
      item('no-time', null),
      item('future', NOW + 3600000)          // 时钟略有偏差的"未来"归入今天
    ]
  });
  assert.deepStrictEqual(groups(), [
    ['Today', ['future', 'today']],
    ['Yesterday', ['yesterday']],
    ['Previous 7 days', ['days-ago-2', 'days-ago-7']],
    ['Previous 30 days', ['days-ago-8', 'days-ago-30']],
    ['Earlier', ['days-ago-31', 'no-time']]
  ]);
});

test('分桶按日历日而不是 24 小时：昨天的 23:59 不会因为过了 5 分钟就掉进"最近 7 天"', async () => {
  const { page, groups, world } = await setup();
  // 把时钟拨到 00:05，此刻"昨天 23:59"只过去了 6 分钟。
  await world.clock.tick(new Date(2026, 10, 25, 0, 5, 0).getTime() - NOW);
  await page({ mode: 'replace', items: [item('late-night', at(0, 23, 59))] });
  assert.deepStrictEqual(groups(), [['Yesterday', ['late-night']]]);
});

test('追加页去重；无论到达顺序如何，始终按更新时间降序', async () => {
  const { page, groups } = await setup();
  await page({ mode: 'replace', items: [item('b', at(0, 9)), item('c', at(1))], hasMore: true });
  await page({ mode: 'append', items: [item('a', at(0, 10)), item('c', at(1)), item('d', at(3))] });
  assert.deepStrictEqual(groups(), [['Today', ['a', 'b']], ['Yesterday', ['c']], ['Previous 7 days', ['d']]]);
});

test('权威首页对账：落在首页时间范围内却消失的会话被移除，更早的各页保留', async () => {
  const { page, groups, view } = await setup();
  await page({ mode: 'replace', items: [item('p1-a', at(0, 10)), item('p1-b', at(0, 9)), item('p1-c', at(0, 8))], hasMore: true });
  await page({ mode: 'append', items: [item('p2-a', at(0, 7)), item('p2-b', at(2))] });
  // 用户删除了 p1-b，p2-a 因为有新活动升到了首页。
  await page({ mode: 'replace', items: [item('p1-a', at(0, 10)), item('p2-a', at(0, 9, 30)), item('p1-c', at(0, 8))] });
  assert.deepStrictEqual(groups(), [['Today', ['p1-a', 'p2-a', 'p1-c']], ['Previous 7 days', ['p2-b']]]);
  assert.equal(view().total, 4);
});

test('权威首页为空 (没有任何会话) 时清空列表；没有有效时间戳的首页不做删除', async () => {
  const { page, view, groups } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0)), item('b', at(40))] });
  await page({ mode: 'replace', items: [item('legacy', null)] });
  assert.deepStrictEqual(groups(), [['Today', ['a']], ['Earlier', ['b', 'legacy']]]);
  await page({ mode: 'replace', items: [] });
  assert.deepStrictEqual(view().groups, []);
  assert.equal(view().total, 0);
});

test('搜索：大小写不敏感、忽略多余空白、只作用于已拉取的会话', async () => {
  const { store, page, view } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0), 'RL 算法 调研'), item('b', at(1), 'Power  Flow'), item('c', at(2), 'OpenGL')] });
  store.setQuery('  rl   算法 ');
  assert.deepStrictEqual(plain(view().groups.map(group => group.items.map(entry => entry.id))), [['a']]);
  store.setQuery('power flow');
  assert.deepStrictEqual(plain(view().groups.map(group => group.items.map(entry => entry.id))), [['b']]);
  store.setQuery('nothing');
  assert.equal(view().shown, 0);
  assert.equal(view().total, 3);
  store.setQuery('');
  assert.equal(view().shown, 3);
  assert.equal(view().query, '');
});

test('搜索时如果列表还没取完，在后台自动继续取，直到取完或清空关键字', async () => {
  const { store, page, requests, world } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  assert.equal(requests().length, 0, '没有关键字时不主动取');
  store.setQuery('x');
  await world.settle();
  assert.equal(requests().length, 0, '页面刚送来首页，先等一等');
  await world.clock.tick(4000);
  assert.deepStrictEqual(requests().map(request => request.kind), ['next']);
  await page({ mode: 'append', items: [item('b', at(5))], hasMore: true, requestId: 'r1' });
  assert.deepStrictEqual(requests().map(request => request.kind), ['next', 'next'], '扩展自己取回一页后立即继续');
  store.setQuery('');
  await page({ mode: 'append', items: [item('c', at(9))], hasMore: true, requestId: 'r2' });
  assert.equal(requests().length, 2, '清空关键字后停止');
});

test('分页：同一时刻只有一个在途请求，响应按 requestId 归位', async () => {
  const { store, page, requests, view, world } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  await world.clock.tick(4000);                    // 页面刚送来一页后的静置期
  assert.equal(store.loadMore(), true);
  assert.equal(store.loadMore(), false, '在途时不重复请求');
  await world.settle();
  assert.deepStrictEqual(requests(), [{ requestId: 'r1', kind: 'next' }]);
  assert.equal(view().loading, true);
  await page({ mode: 'append', items: [item('b', at(3))], hasMore: false, requestId: 'r1' });
  assert.equal(view().loading, false);
  assert.equal(store.loadMore(), false, '到底后不再请求');
  await world.clock.tick(10000);
  assert.equal(requests().length, 1);
});

test('页面在连续翻页时 (如 History 页)，搜索的后台加载不抢发，静置后才接力', async () => {
  const { store, page, requests, world } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  store.setQuery('x');
  await page({ mode: 'append', items: [item('b', at(3))], hasMore: true });
  await world.clock.tick(3900);
  assert.equal(requests().length, 0, '页面在连续翻页期间不发请求');
  await world.clock.tick(200);
  assert.deepStrictEqual(requests(), [{ requestId: 'r1', kind: 'next' }]);
});

test('loadMore 只管"能不能取"：页面刚送来一页也照常立即出手，等不等由调用方决定', async () => {
  const { store, page, requests, world } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  assert.equal(store.loadMore(), true);
  await world.settle();
  assert.deepStrictEqual(requests(), [{ requestId: 'r1', kind: 'next' }]);
});

test('出错后停在原地等待重试，重试或页面送来新数据后恢复', async () => {
  const { store, page, error, requests, view, world } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  await world.clock.tick(4000);
  store.loadMore();
  await error({ code: 'network', requestId: 'r1' });
  assert.deepStrictEqual(plain(view().error), { code: 'network' });
  assert.equal(view().loading, false);
  assert.equal(store.loadMore(), false, '出错后不自动重试');
  store.retry();
  store.loadMore();
  await world.settle();
  assert.deepStrictEqual(requests().map(request => request.requestId), ['r1', 'r2']);
  await error({ code: 'unauthorized', requestId: 'r2' });
  await page({ mode: 'append', items: [item('b', at(3))], hasMore: false });
  assert.equal(view().error, null, '页面送来数据会清掉错误');
});

test('还什么都没显示出来时，页面侧的错误才会提示；已有会话时静默忽略', async () => {
  const { page, error, view } = await setup();
  await error({ code: 'unparseable', requestId: null });
  assert.deepStrictEqual(plain(view().error), { code: 'unparseable' });
  await page({ mode: 'replace', items: [item('a', at(0))] });
  await error({ code: 'unparseable', requestId: null });
  assert.equal(view().error, null);
});

test('首页格式整体认不出 (站点改版) 时给出明确状态，而不是一直转圈', async () => {
  const { page, view } = await setup();
  await page({ mode: 'replace', items: [], hasMore: false, unrecognized: 100 });
  assert.deepStrictEqual(plain(view().error), { code: 'unrecognized' });
});

test('会话增删改与"打开了列表外的会话"都会触发首页重新同步，且有冷却与排队', async () => {
  const { store, protocol, page, requests, world } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  protocol.send(protocol.INVALIDATED, {});
  store.noteCurrentPrompt('brand-new');
  await world.settle();
  assert.deepStrictEqual(requests().map(request => request.kind), ['first'], '冷却期内的多次触发只算一次');
  await page({ mode: 'replace', items: [item('a', at(0)), item('brand-new', at(0, 13))], hasMore: true, requestId: 'r1' });
  store.noteCurrentPrompt('brand-new');
  await world.clock.tick(4000);                    // 过了静置期
  store.loadMore();
  await world.settle();
  assert.deepStrictEqual(requests().map(request => request.kind), ['first', 'next']);
  protocol.send(protocol.INVALIDATED, {});
  await world.settle();
  assert.equal(requests().length, 2, '在途时先排队');
  await page({ mode: 'append', items: [], hasMore: false, requestId: 'r2' });
  assert.deepStrictEqual(requests().map(request => request.kind), ['first', 'next', 'first'], '在途请求结束后补上');
});

test('冷却期内又来了变更：不丢弃，冷却一结束就补一次同步', async () => {
  const { protocol, page, requests, world } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  protocol.send(protocol.INVALIDATED, {});
  await world.settle();
  await page({ mode: 'replace', items: [item('a', at(0))], requestId: 'r1' });
  protocol.send(protocol.INVALIDATED, {});
  await world.settle();
  assert.equal(requests().length, 1, '冷却期内不立刻发');
  await world.clock.tick(2999);
  assert.equal(requests().length, 1);
  await world.clock.tick(1);
  assert.deepStrictEqual(requests().map(request => request.kind), ['first', 'first'], '冷却一结束就补上');
});

test('被推迟的同步若已被更新的首页数据覆盖 (自己取到的或页面送来的)，就不再重复', async () => {
  const self = await setup();
  await self.page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  self.protocol.send(self.protocol.INVALIDATED, {});
  await self.world.settle();                                      // 发出 r1
  self.protocol.send(self.protocol.INVALIDATED, {});              // 冷却期内：推迟
  await self.page({ mode: 'replace', items: [item('a', at(0))], requestId: 'r1' });   // r1 比它晚发出 → 已覆盖
  await self.world.clock.tick(10000);
  assert.equal(self.requests().length, 1, '不再补发');

  const fromPage = await setup();
  await fromPage.page({ mode: 'replace', items: [item('a', at(0))], hasMore: true });
  fromPage.protocol.send(fromPage.protocol.INVALIDATED, {});
  await fromPage.world.settle();                                      // 发出 r1
  await fromPage.world.clock.tick(500);
  fromPage.protocol.send(fromPage.protocol.INVALIDATED, {});          // 冷却期内：推迟 (晚于 r1)
  await fromPage.page({ mode: 'replace', items: [item('a', at(0))], requestId: 'r1' });
  await fromPage.world.clock.tick(500);
  assert.equal(fromPage.requests().length, 1, 'r1 发出得更早，覆盖不到，推迟仍然有效');
  await fromPage.page({ mode: 'replace', items: [item('a', at(0))] });   // 页面自己重新拉了首页
  await fromPage.world.clock.tick(10000);
  assert.equal(fromPage.requests().length, 1, '页面送来的首页同样算数');
});

test('改名与删除在本地立即生效，并进入缓存', async () => {
  const { store, page, world, view, groups } = await setup();
  await page({ mode: 'replace', items: [item('a', at(0), 'Old'), item('b', at(1), 'B')] });
  assert.equal(store.rename('a', 'New'), true);
  assert.equal(store.rename('a', 'New'), false, '标题没变时不重复通知');
  assert.equal(store.rename('missing', 'x'), false);
  assert.deepStrictEqual(groups(), [['Today', ['a']], ['Yesterday', ['b']]]);
  assert.equal(view().groups[0].items[0].title, 'New');
  assert.equal(store.remove('b'), true);
  assert.equal(store.remove('b'), false);
  assert.deepStrictEqual(groups(), [['Today', ['a']]]);
  await world.clock.tick(400);
  assert.equal(JSON.parse(world.storage.get('aistudio-plus:history:v1')).items.length, 1);
});

test('会话级缓存：延迟写入 sessionStorage，再次打开时先呈现缓存并标为未同步', async () => {
  const first = await setup();
  await first.page({ mode: 'replace', items: [item('a', at(0), '缓存 A'), item('b', at(60))] });
  assert.equal(first.world.storage.size, 0, '合并时先不落盘');
  await first.world.clock.tick(400);
  const saved = first.world.storage.get('aistudio-plus:history:v1');
  assert.equal(JSON.parse(saved).v, 1);
  assert.equal(JSON.parse(saved).items.length, 2);

  const second = await setup({ storage: new Map([['aistudio-plus:history:v1', saved]]) });
  assert.deepStrictEqual(second.groups(), [['Today', ['a']], ['Earlier', ['b']]]);
  assert.equal(second.view().live, false);
  assert.equal(second.view().hasMore, true);
  await second.page({ mode: 'replace', items: [item('a', at(0), '改名了')] });     // 真实数据到达后对账
  assert.equal(second.groups()[0][1].length, 1);
  assert.equal(second.view().total, 2, '缓存里更早的会话保留');
});

test('坏掉的缓存不会让仓库出错', async () => {
  const broken = await setup({ storage: new Map([['aistudio-plus:history:v1', '{not json']]) });
  assert.equal(broken.view().total, 0);
  const wrongVersion = await setup({ storage: new Map([['aistudio-plus:history:v1', '{"v":2,"items":[]}']]) });
  assert.equal(wrongVersion.view().total, 0);
});

test('非法的会话数据被忽略：id 不合法、标题不是字符串', async () => {
  const { page, view } = await setup();
  await page({ mode: 'replace', items: [item('ok', at(0)), item('bad id', at(0)), { id: 'no-title', title: 42, updatedAt: at(0) }, null, 'prompts/x'] });
  assert.deepStrictEqual(plain(view().groups.map(group => group.items.map(entry => [entry.id, entry.title]))), [
    [['ok', 'Title ok'], ['no-title', '']]
  ]);
});

test('回到长时间挂着的页面：重新分桶，超过 10 分钟没同步则刷新', async () => {
  const { store, page, requests, world, groups } = await setup();
  await page({ mode: 'replace', items: [item('late', at(0, 23, 59))], hasMore: false });
  await world.clock.tick(new Date(2026, 10, 25, 0, 2, 0).getTime() - NOW);     // 跨过零点
  assert.deepStrictEqual(groups(), [['Today', ['late']]], '没有状态变化时沿用上次的视图');
  world.window.document.hidden = false;
  world.window.document.dispatch('visibilitychange');
  assert.deepStrictEqual(groups(), [['Yesterday', ['late']]], '切回页面时按新的日期重新分桶');
  assert.equal(requests().length, 0, '刚同步过，不刷新');
  await world.clock.tick(11 * 60000);
  world.window.document.dispatch('visibilitychange');
  assert.deepStrictEqual(requests().map(request => request.kind), ['first']);
  assert.deepStrictEqual(groups(), [['Yesterday', ['late']]]);
});

test('subscribe 立即回调一次，退订后不再通知', async () => {
  const { store, page } = await setup();
  const seen = [];
  const stop = store.subscribe(view => seen.push(view.total));
  await page({ mode: 'replace', items: [item('a', at(0))] });
  stop();
  await page({ mode: 'append', items: [item('b', at(3))] });
  assert.deepStrictEqual(seen, [0, 1]);
});
