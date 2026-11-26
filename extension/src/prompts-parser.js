/**
 * AI Studio Plus - Prompts Parser
 * 解析 MakerSuiteService/ListPrompts 的请求体与响应体。纯函数，不依赖 DOM。
 *
 * 线上编码（2026-11 实测，Content-Type: application/json+protobuf，jspb 数组 JSON）：
 *   请求  [每页条数, 游标?]                  例：[100] 或 [100, "~!!~…"]
 *   响应  [[记录, 记录, …], 下一页游标?]      末页没有游标
 *   记录  ["prompts/<id>", null, null, null, 元数据, …]
 *   元数据 [标题, null, [作者, …], null, [[秒, 纳秒], 修改者], …]
 * 其中 [秒, 纳秒] 是会话的更新时间（History 页的 "Updated" 列，也是服务端的排序键）。
 */
globalThis.AIPPromptsParser = (() => {
  const ID = globalThis.AIPProtocol?.ID_PATTERN || /^[A-Za-z0-9_-]{1,128}$/;
  const collapseSpaces = globalThis.AIPProtocol?.collapseSpaces || (v => String(v ?? '').replace(/\s+/g, ' ').trim());
  const MAX_PAGE_SIZE = 1000;
  const XSSI_PREFIX = ")]}'";

  // JSON.parse 前剥掉 Google 的 XSSI 防护前缀。认不出时返回 null。
  function parseJson(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const xssi = text.indexOf(XSSI_PREFIX);
    try {
      return JSON.parse(xssi >= 0 ? text.slice(xssi + XSSI_PREFIX.length) : text);
    } catch (_) {
      return null;
    }
  }

  // google.protobuf.Timestamp 的数组编码：[秒（字符串）, 纳秒]。无效时返回 null。
  function toMillis(value) {
    if (!Array.isArray(value)) return null;
    const seconds = Number(value[0]);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return seconds * 1000 + Math.floor((Number(value[1]) || 0) / 1e6);
  }

  function toRecord(record) {
    if (!Array.isArray(record) || typeof record[0] !== 'string' || !record[0].startsWith('prompts/')) return null;
    const id = record[0].slice('prompts/'.length);
    if (!ID.test(id)) return null;
    const meta = Array.isArray(record[4]) ? record[4] : null;
    return {
      id,
      title: meta && typeof meta[0] === 'string' ? collapseSpaces(meta[0]) : '',
      updatedAt: meta ? toMillis(meta[4] && meta[4][0]) : null
    };
  }

  // 响应体 → { items, nextPageToken, unrecognized }；整体认不出时返回 null。
  function parseResponse(text) {
    const data = parseJson(text);
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
    const items = [];
    let unrecognized = 0;
    for (const record of data[0]) {
      const item = toRecord(record);
      if (item) items.push(item);
      else unrecognized += 1;
    }
    return {
      items,
      nextPageToken: typeof data[1] === 'string' && data[1] ? data[1] : null,
      unrecognized
    };
  }

  // 请求体 → { pageSize, token, folder }；整体认不出时返回 null。
  function parseRequest(body) {
    const data = parseJson(body);
    if (!Array.isArray(data)) return null;
    const size = Number(data[0]);
    return {
      pageSize: Number.isInteger(size) && size > 0 && size <= MAX_PAGE_SIZE ? size : null,
      token: typeof data[1] === 'string' && data[1] ? data[1] : null,
      folder: typeof data[2] === 'string' ? data[2] : null       // 会话所在的文件夹 (Google Drive)，默认位置为空
    };
  }

  // ---- 改名 / 复制 (结构取自官方客户端) ----------------------------------------------------------
  // ResolveDriveResource 返回的是完整会话：[记录]。列表接口给的记录缺下标 3 的模型配置（下标 4 的元数据字段之前），
  // 所以凡是整体提交 (UpdatePrompt / CreatePrompt) 之前都必须先取这一份。
  function parseFullPrompt(text) {
    const data = parseJson(text);
    if (!Array.isArray(data) || !Array.isArray(data[0]) || typeof data[0][0] !== 'string') return null;
    return data[0];
  }

  function titleOf(record) {
    const meta = Array.isArray(record) && Array.isArray(record[4]) ? record[4] : null;
    return meta && typeof meta[0] === 'string' ? meta[0] : '';
  }

  // 深拷贝后改标题：绝不改动缓存里的原件。
  function withTitle(record, title) {
    const copy = JSON.parse(JSON.stringify(record));
    const meta = Array.isArray(copy[4]) ? copy[4] : [];
    meta[0] = title;
    copy[4] = meta;
    return copy;
  }

  // 官方的 "Make a copy"：清空资源名后按新建提交。
  function asCopy(record, title) {
    const copy = withTitle(record, title);
    copy[0] = '';
    return copy;
  }

  // 改名之后页面内存里的标题可能还是旧值，它之后自己提交 UpdatePrompt 时会把旧标题写回去。
  // 这里判断一份即将发出的请求体要不要改写：
  //   { body }   页面带的还是改名前的旧标题 → 换成新标题
  //   { drop, id } 页面把标题改成了别的值 (用户在官方界面又改了名) → 这道保护不再需要
  //   null       与受保护的会话无关
  function guardTitle(body, guards) {
    if (!guards.size || typeof body !== 'string' || body[0] !== '[') return null;
    let data;
    try {
      data = JSON.parse(body);
    } catch (_) {
      return null;
    }
    const record = Array.isArray(data) ? data[0] : null;
    if (!Array.isArray(record) || typeof record[0] !== 'string' || !record[0].startsWith('prompts/')) return null;
    const guard = guards.get(record[0].slice('prompts/'.length));
    if (!guard) return null;
    const current = titleOf(record);
    if (current === guard.to) return null;
    if (current !== guard.from) return { drop: true, id: record[0].slice('prompts/'.length) };
    const next = data.slice();
    next[0] = withTitle(record, guard.to);
    return { body: JSON.stringify(next) };
  }

  return { parseResponse, parseRequest, parseFullPrompt, titleOf, withTitle, asCopy, guardTitle };
})();
