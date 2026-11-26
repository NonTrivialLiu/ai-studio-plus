import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, page, plain, record } from './harness.mjs';

const world = createWorld();
world.load('prompts-parser.js');
const { parseResponse, parseRequest, parseFullPrompt, titleOf, withTitle, asCopy, guardTitle } = world.window.AIPPromptsParser;

test('解析实测的线上编码：记录 → { id, title, updatedAt }', () => {
  const result = parseResponse(page(
    [record({ id: '1PAn_-XQmgrUr9I7hRqMZublLkPQTifvC', title: 'LCC 注入机理', seconds: 1795515277, nanos: 50000000 })],
    '~!!~CAESUGp'
  ));
  assert.deepStrictEqual(plain(result), {
    items: [{ id: '1PAn_-XQmgrUr9I7hRqMZublLkPQTifvC', title: 'LCC 注入机理', updatedAt: 1795515277050 }],
    nextPageToken: '~!!~CAESUGp',
    unrecognized: 0
  });
});

test('末页没有游标；空字符串游标视同没有', () => {
  assert.equal(parseResponse(page([record({ id: 'a', title: 'A', seconds: 10 })])).nextPageToken, null);
  assert.equal(parseResponse(page([record({ id: 'a', title: 'A', seconds: 10 })], '')).nextPageToken, null);
});

test('空列表 (还没有任何会话) 与带 XSSI 前缀的响应', () => {
  assert.deepStrictEqual(plain(parseResponse('[[]]')), { items: [], nextPageToken: null, unrecognized: 0 });
  assert.equal(parseResponse(")]}'\n" + page([record({ id: 'a', title: 'A', seconds: 10 })], 't')).items.length, 1);
});

test('整体认不出的输入返回 null', () => {
  for (const bad of [undefined, null, '', '   ', 'not json', '{}', '[]', '[null]', '[1]', '[{}, "t"]', 42]) {
    assert.equal(parseResponse(bad), null, String(bad));
  }
});

test('标题里的换行与多余空白被压成单个空格', () => {
  const [item] = parseResponse(page([record({ id: 'a', title: '  第一行\n\t第二行   结尾  ', seconds: 10 })])).items;
  assert.equal(item.title, '第一行 第二行 结尾');
});

test('缺少元数据时标题为空、时间为空，记录本身仍然有效', () => {
  const result = parseResponse('[[["prompts/b", null, null, null, null]]]');
  assert.deepStrictEqual(plain(result.items), [{ id: 'b', title: '', updatedAt: null }]);
});

test('时间字段的容错：无效秒数或非数字时为空，纳秒换算成毫秒', () => {
  const seconds = [0, -5, 'abc', null];
  const result = parseResponse(page(seconds.map((value, i) => record({ id: 't' + i, title: 'T', seconds: value }))));
  assert.deepStrictEqual(plain(result.items.map(item => item.updatedAt)), [null, null, null, null]);
  const ok = parseResponse(page([
    record({ id: 'n0', title: 'T', seconds: '1795515277', nanos: 0 }),
    record({ id: 'n1', title: 'T', seconds: '1795515277', nanos: 999999999 }),
    record({ id: 'n2', title: 'T', seconds: 1795515277, nanos: null })
  ]));
  assert.deepStrictEqual(plain(ok.items.map(item => item.updatedAt)), [1795515277000, 1795515277999, 1795515277000]);
});

test('不是会话记录的条目被计入 unrecognized，不会混进列表', () => {
  const result = parseResponse(JSON.stringify([
    [record({ id: 'ok', title: 'OK', seconds: 10 }), null, 'prompts/has space', ['notes/xyz'], ['prompts/bad/id'], { name: 'prompts/x' }],
    't'
  ]));
  assert.deepStrictEqual(plain(result.items.map(item => item.id)), ['ok']);
  assert.equal(result.unrecognized, 5);
});

test('请求体：每页条数与游标', () => {
  assert.deepStrictEqual(plain(parseRequest('[100]')), { pageSize: 100, token: null, folder: null });
  assert.deepStrictEqual(plain(parseRequest('[50, "~!!~abc"]')), { pageSize: 50, token: '~!!~abc', folder: null });
  assert.deepStrictEqual(plain(parseRequest('[100, null, "folder-1"]')), { pageSize: 100, token: null, folder: 'folder-1' });
  for (const size of [0, -1, 2.5, 5000, 'abc', null]) {
    assert.equal(parseRequest(JSON.stringify([size])).pageSize, null, String(size));
  }
  for (const bad of [undefined, null, 100, '', '{}', 'text']) assert.equal(parseRequest(bad), null, String(bad));
});

// ---- 改名 / 复制 --------------------------------------------------------------------------------

// ResolveDriveResource 的响应是 [完整记录]；完整记录的第 4 个字段 (模型配置) 在列表接口里是空的。
const FULL = (() => {
  const full = record({ id: 'abc', title: '旧标题', seconds: 100 });
  full[3] = [1, 2, 3];
  return JSON.stringify([full]);
})();

test('解析完整会话：ResolveDriveResource 的响应 → 记录', () => {
  const record1 = parseFullPrompt(FULL);
  assert.equal(titleOf(record1), '旧标题');
  assert.deepStrictEqual(plain(record1[3]), [1, 2, 3], '列表记录里缺失的第 4 个字段 (模型配置) 在这里是有的');
  assert.equal(parseFullPrompt('[null]'), null);
  assert.equal(parseFullPrompt('{}'), null);
  assert.equal(parseFullPrompt('oops'), null);
});

test('改标题是深拷贝，不动缓存里的原件；缺元数据时补上', () => {
  const original = parseFullPrompt(FULL);
  const renamed = withTitle(original, '新标题');
  assert.equal(titleOf(renamed), '新标题');
  assert.equal(titleOf(original), '旧标题', '原件没被改动');
  renamed[3].push(4);
  assert.deepStrictEqual(plain(original[3]), [1, 2, 3], '深拷贝：嵌套字段互不影响');
  assert.deepEqual(plain(withTitle(['prompts/x'], 'T')[4]), ['T']);
  assert.equal(titleOf(['prompts/x']), '', '没有元数据时标题为空而不是报错');
});

test('"Make a copy"：清空资源名并换成新标题，其余原样', () => {
  const copy = asCopy(parseFullPrompt(FULL), 'Copy of 旧标题');
  assert.equal(copy[0], '');
  assert.equal(titleOf(copy), 'Copy of 旧标题');
  assert.deepStrictEqual(plain(copy[3]), [1, 2, 3]);
});

test('标题保护：页面带着改名前的旧标题提交时换成新标题；带着新标题或别的标题时不动', () => {
  const guards = new Map([['abc', { from: '旧标题', to: '新标题' }]]);
  const update = title => JSON.stringify([withTitle(parseFullPrompt(FULL), title), null, 'folder-1']);
  const patched = guardTitle(update('旧标题'), guards);
  assert.equal(titleOf(JSON.parse(patched.body)[0]), '新标题');
  assert.deepStrictEqual(plain(JSON.parse(patched.body).slice(1)), [null, 'folder-1'], '请求体里其余字段保持原样');
  assert.equal(guardTitle(update('新标题'), guards), null);
  assert.deepEqual(plain(guardTitle(update('后来又在官方界面改的名字'), guards)), { drop: true, id: 'abc' }, '页面自己又改了名：保护撤掉');
  assert.equal(guardTitle(update('旧标题'), new Map()), null, '没有保护时不动任何请求');
  assert.equal(guardTitle('not json', guards), null);
  assert.equal(guardTitle(JSON.stringify([withTitle(parseFullPrompt(FULL), '旧标题')]), new Map([['other', { from: '旧标题', to: 'x' }]])), null, '不是受保护的那个会话');
});
