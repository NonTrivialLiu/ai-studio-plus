/**
 * AI Studio Plus - Interceptor
 * 运行在宿主页面的 MAIN 世界 (document_start)，挂钩 XMLHttpRequest 与 fetch：
 *   1. 读取页面自己发出的 ListPrompts 响应，整理成 { id, title, updatedAt } 推给扩展世界；
 *   2. 应扩展世界的请求，复用页面的地址与请求头代取下一页 (无限滚动)；
 *   3. 应扩展世界的请求执行改名 / 复制 / 删除，做法与官方界面逐字一致；
 *   4. 会话被新建 / 改名 / 删除时通知重新同步，路由变化时通知更新高亮。
 * 不读取 Cookie、不落盘、不解析其它接口的响应体。
 */
(() => {
  // 重入保护：同一个世界只挂钩一次 (manifest 注入与兜底注入可能先后到达)。
  if (globalThis.__AIP_INTERCEPTOR__) return;
  // 若被注入到了扩展世界 (浏览器不支持 content_scripts.world = "MAIN")，挂钩并不生效，
  // 也不打标记，留给 main.js 在 DOM 就绪后走兜底注入。
  const runtime = (globalThis.chrome && globalThis.chrome.runtime) || (globalThis.browser && globalThis.browser.runtime);
  if (runtime && runtime.id) return;
  globalThis.__AIP_INTERCEPTOR__ = true;

  const protocol = globalThis.AIPProtocol;
  const parser = globalThis.AIPPromptsParser;
  const parseResponse = parser.parseResponse;
  const parseRequest = parser.parseRequest;

  const MARKER = 'data-aip-interceptor';   // DOM 是两个世界共享的，用它告诉 main.js "主世界已就位"
  // 线上地址形如 …/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListPrompts：
  // 服务名前是句点。这里只认 "MakerSuiteService/<方法>"，不依赖版本号与前导字符。
  const API = /MakerSuiteService\//;
  const RPC = /MakerSuiteService\/(ListPrompts|CreatePrompt|UpdatePrompt|DeletePrompt)(?=[?#]|$)/;
  const KINDS = { listprompts: 'list', createprompt: 'create', updateprompt: 'update', deleteprompt: 'delete' };
  const ID = protocol.ID_PATTERN;
  const DEFAULT_PAGE_SIZE = 100;
  const REQUEST_TIMEOUT_MS = 20000;
  const PAGE_SETTLE_MS = 15000;
  const FIRST_PAGE_DELAY_MS = 8000;        // 兜底注入晚于页面启动时，等这么久再自己去取首页
  const INVALIDATE_DELAY_MS = 1500;
  const MAX_EMPTY_PAGES = 3;
  const MAX_TITLE_GUARDS = 100;
  const RATE_LIMIT = 60;                    // 每分钟最多代发这么多次请求，兜住任何意外死循环
  const RATE_WINDOW_MS = 60000;

  const nativeFetch = globalThis.fetch;
  const xhrTrackers = new WeakMap();
  const settleWaiters = new Set();
  const requestTimes = [];
  // 在这里改过名的会话：页面内存里的标题可能还是旧值，它之后自己提交时据此纠正。
  const titleGuards = new Map();            // 会话 id → { from: 改名前的标题, to: 新标题 }

  let template = null;       // { url, headers, pageSize, folder }：页面自己请求 ListPrompts 时留下的样板
  let authSource = null;     // 还没见到 ListPrompts 时，先记下任意 MakerSuiteService 请求的地址与请求头
  let nextToken = null;      // 下一页游标；为空表示从头取，或者已经到底
  let exhausted = false;     // 是否已经取到历史末尾
  let firstPage = null;      // 最近一次首页的结果，扩展世界晚到时重放给它
  let firstWanted = false;   // 兜底：扩展世界就绪时手里还没有首页
  let firstDue = false;      // 兜底：等够了 FIRST_PAGE_DELAY_MS，页面仍没送来首页，该自己取了
  let pageInflight = 0;      // 页面自己发出、尚未返回的 ListPrompts 请求数
  let emptyStreak = 0;
  let lastListSentAt = 0;
  let lastPath = '';
  let invalidateTimer = 0;
  let invalidateAt = 0;

  if (document.documentElement) document.documentElement.setAttribute(MARKER, '1');

  // 1. 请求识别 ---------------------------------------------------------------------------------

  // 给一次页面请求归类：list / create / update / delete / api (其它 MakerSuiteService) / null (无关请求)。
  function track(method, url) {
    if (typeof url !== 'string' || !API.test(url)) return { kind: null, method, url: '', headers: {}, body: null };
    let resolved = url;
    try {
      resolved = new URL(url, location.href).href;
    } catch (_) {}
    const match = RPC.exec(resolved);
    return { kind: match ? KINDS[match[1].toLowerCase()] : 'api', method, url: resolved, headers: {}, body: null, settled: false };
  }

  function responseText(response) {
    try {
      if (response.responseType === '' || response.responseType === 'text') return response.responseText;
      if (response.responseType === 'json') return response.response ? JSON.stringify(response.response) : '';
      if (response.responseType === 'arraybuffer' && response.response) return new TextDecoder().decode(response.response);
    } catch (_) {}
    return '';
  }

  function failureCode(status) {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 404) return 'not-found';
    if (status === 429) return 'rate-limited';
    return 'http';
  }

  // 2. 样板：页面怎么请求 ListPrompts，我们就怎么请求 ---------------------------------------------

  function learn(tracker) {
    if (tracker.kind === 'list') {
      const request = parseRequest(tracker.body);
      template = {
        url: tracker.url,
        headers: tracker.headers,
        pageSize: (request && request.pageSize) || (template && template.pageSize) || DEFAULT_PAGE_SIZE,
        folder: (request && request.folder) || (template && template.folder) || ''
      };
      authSource = null;
    } else if (tracker.kind === 'api' && !template) {
      authSource = { url: tracker.url, headers: tracker.headers };
    } else if (template) {
      // 所有 MakerSuiteService 请求携带同一套请求头，其中只有 Authorization 随时间变化：顺手保鲜。
      const name = Object.keys(tracker.headers).find(key => key.toLowerCase() === 'authorization');
      const own = Object.keys(template.headers).find(key => key.toLowerCase() === 'authorization');
      if (name && own) template.headers[own] = tracker.headers[name];
    }
    if (firstDue) takeFirstIfReady();
  }

  function ensureTemplate() {
    if (template) return template;
    if (!authSource) return null;
    // 兜底：页面从未 (或尚未) 请求过 ListPrompts 时，用同一个网关上的其它请求推出它的地址与请求头。
    template = {
      url: authSource.url.replace(/([^/?#]+)([?#].*)?$/, 'ListPrompts$2'),
      headers: authSource.headers,
      pageSize: DEFAULT_PAGE_SIZE,
      folder: ''
    };
    authSource = null;
    return template;
  }

  // 3. 响应处理 ---------------------------------------------------------------------------------

  function settle(tracker, ok, text) {
    if (tracker.settled) return;
    tracker.settled = true;
    if (tracker.kind === 'list') {
      pageInflight = Math.max(0, pageInflight - 1);
      for (const done of Array.from(settleWaiters)) done();
    }
    if (ok) handle(tracker, text);
    if (tracker.kind === 'list' && firstDue) takeFirstIfReady();   // 页面的那次没成功时才轮到自己
  }

  function handle(tracker, text) {
    if (tracker.kind !== 'list') return invalidate(tracker.kind);
    if (!text || !text.trim()) return;
    const page = parseResponse(text);
    if (!page) return publishError('unparseable', null);
    // 请求体带游标就是追加页，否则是首页。请求体认不出时，按"手里是否有待取的游标"推断。
    const request = parseRequest(tracker.body);
    const append = request ? !!request.token : !!nextToken;
    nextToken = page.nextPageToken;
    exhausted = !nextToken;
    if (!append) emptyStreak = 0;
    publish(append ? 'append' : 'replace', page, null);
  }

  function invalidate(reason) {
    invalidateAt = Date.now();
    clearTimeout(invalidateTimer);
    invalidateTimer = setTimeout(() => {
      // 页面自己已经重新拉过首页 (例如 History 页删除后会刷新列表)，就不再多请求一次。
      if (lastListSentAt > invalidateAt) return;
      protocol.send(protocol.INVALIDATED, { reason });
    }, INVALIDATE_DELAY_MS);
  }

  function publish(mode, page, requestId) {
    if (mode === 'replace') firstPage = page;
    protocol.send(protocol.PAGE, {
      mode,
      items: page.items,
      hasMore: !!page.nextPageToken,
      unrecognized: page.unrecognized || 0,
      requestId: requestId || null
    });
  }

  function publishError(code, requestId) {
    protocol.send(protocol.ERROR, { code, requestId: requestId || null });
  }

  // 4. 代发请求 ---------------------------------------------------------------------------------

  // 用页面的样板发一次请求：同一个服务、同一套请求头、带凭据 (线上接口同时校验 Cookie)。
  async function call(method, body) {
    const source = ensureTemplate();
    if (!source || typeof nativeFetch !== 'function') {
      throw Object.assign(new Error('no request template'), { code: 'no-template' });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await nativeFetch(source.url.replace(/([^/?#]+)([?#].*)?$/, method + '$2'), {
        method: 'POST',
        credentials: 'include',
        headers: source.headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { code: failureCode(response.status) });
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchPage(token) {
    const source = ensureTemplate();
    if (!source) {
      throw Object.assign(new Error('no request template'), { code: 'no-template' });
    }
    const body = source.folder
      ? [source.pageSize, token || null, source.folder]
      : (token ? [source.pageSize, token] : [source.pageSize]);
    const page = parseResponse(await call('ListPrompts', body));
    if (!page) throw Object.assign(new Error('unparseable response'), { code: 'unparseable' });
    return page;
  }

  function samePage(a, b) {
    return !!a && !!b && a.items.length === b.items.length &&
      a.items.every((item, index) => b.items[index].id === item.id && b.items[index].updatedAt === item.updatedAt);
  }

  async function requestPage(kind, requestId) {
    const token = kind === 'next' ? nextToken : null;
    try {
      const page = await fetchPage(token);
      if (token) {
        // 游标原地踏步或连续返回空页，说明服务端异常：按"到底"处理，避免无限请求。
        emptyStreak = page.items.length ? 0 : emptyStreak + 1;
        if (page.nextPageToken === token || emptyStreak >= MAX_EMPTY_PAGES) page.nextPageToken = null;
      } else {
        emptyStreak = 0;
      }
      const firstPageUnchanged = !token && samePage(firstPage, page);
      if (firstPageUnchanged && (nextToken || exhausted)) {
        // 首页没有变化：若已拿到更深的游标或已到底，保留该状态，免得重新翻一遍或误开启翻页。
        if (exhausted) page.nextPageToken = null;
      } else {
        nextToken = page.nextPageToken;
        exhausted = !nextToken;
      }
      publish(token ? 'append' : 'replace', page, requestId);
    } catch (error) {
      publishError(errorCode(error), requestId);
    }
  }

  function errorCode(error) {
    if (error && error.name === 'AbortError') return 'timeout';
    return (error && typeof error.code === 'string' && error.code) || 'network';
  }

  function takeFirstIfReady() {
    if (!firstDue || firstPage || pageInflight > 0 || !ensureTemplate()) return;   // 页面自己的列表请求在途：等它的结果
    firstDue = false;
    firstWanted = false;
    requestPage('first', null);
  }

  // 5. 改名 / 复制 / 删除：做法与官方界面一致 ------------------------------------------------------
  // 列表接口给的记录缺模型配置等字段，所以先取完整会话 (ResolveDriveResource)，改完再整体提交。

  async function runAction(payload) {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId.slice(0, 64) : '';
    const id = typeof payload.id === 'string' && ID.test(payload.id) ? payload.id : '';
    const action = ['rename', 'copy', 'delete'].includes(payload.action) ? payload.action : '';
    if (!requestId || !id || !action) return;
    const reply = (ok, extra) => protocol.send(protocol.RESULT, Object.assign({ requestId, action, ok }, extra || {}));
    try {
      const source = ensureTemplate();
      if (!source) return reply(false, { code: 'no-template' });
      const folder = source.folder || '';
      if (action === 'delete') {
        await call('DeletePrompt', folder ? [`prompts/${id}`, folder] : [`prompts/${id}`]);
        titleGuards.delete(id);
      } else {
        const record = parser.parseFullPrompt(await call('ResolveDriveResource', [id]));
        if (!record) throw Object.assign(new Error('unparseable full prompt'), { code: 'unparseable' });
        if (action === 'rename') {
          const title = protocol.collapseSpaces(payload.title);
          if (!title || title.length > 2000) throw Object.assign(new Error('invalid title'), { code: 'invalid' });
          await call('UpdatePrompt', [parser.withTitle(record, title)].concat(folder ? [null, folder] : []));
          if (titleGuards.has(id)) titleGuards.delete(id);
          if (titleGuards.size >= MAX_TITLE_GUARDS) titleGuards.delete(titleGuards.keys().next().value);
          titleGuards.set(id, { from: parser.titleOf(record), to: title });
        } else {
          await call('CreatePrompt', [parser.asCopy(record, String(payload.title || ''))].concat(folder ? [folder] : []));
        }
      }
      protocol.send(protocol.INVALIDATED, { reason: action });   // 列表变了：马上重新同步，不用等防抖
      reply(true);
    } catch (error) {
      reply(false, { code: errorCode(error) });
    }
  }

  // 页面即将提交一份 UpdatePrompt：若它带的还是在这里改名之前的旧标题，就换成新标题。
  function guardedBody(body) {
    const verdict = parser.guardTitle(body, titleGuards);
    if (!verdict) return null;
    if (verdict.drop) titleGuards.delete(verdict.id);
    return verdict.body || null;
  }

  // 6. 与扩展世界通信 ---------------------------------------------------------------------------

  function allowRequest() {
    const now = Date.now();
    while (requestTimes.length && now - requestTimes[0] > RATE_WINDOW_MS) requestTimes.shift();
    if (requestTimes.length >= RATE_LIMIT) return false;
    requestTimes.push(now);
    return true;
  }

  // 页面自己正在取下一页时等它返回，避免同一个游标请求两遍。
  function waitForPage() {
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        settleWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, PAGE_SETTLE_MS);
      settleWaiters.add(done);
    });
  }

  async function onRequest(payload) {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId.slice(0, 64) : '';
    if (!requestId) return;
    if (!allowRequest()) return publishError('rate-limited', requestId);
    if (pageInflight > 0) await waitForPage();
    await requestPage(payload.kind === 'first' ? 'first' : 'next', requestId);
  }

  // 兜底注入晚于页面启动时，页面的首页请求可能已经错过：等一会儿 (给页面自己的请求留出时间)，
  // 仍然没有首页就用自己的样板补取一次。
  function onHello() {
    if (firstPage) return publish('replace', firstPage, null);
    if (firstWanted) return;
    firstWanted = true;
    setTimeout(() => {
      firstDue = true;
      takeFirstIfReady();
    }, FIRST_PAGE_DELAY_MS);
  }

  // 7. 挂钩 -------------------------------------------------------------------------------------

  const xhrPrototype = globalThis.XMLHttpRequest && XMLHttpRequest.prototype;
  if (xhrPrototype) {
    const { open, send, setRequestHeader } = xhrPrototype;
    xhrPrototype.open = function(method, url) {
      xhrTrackers.set(this, track(String(method || 'GET').toUpperCase(), url));
      return open.apply(this, arguments);
    };
    xhrPrototype.setRequestHeader = function(name, value) {
      const tracker = xhrTrackers.get(this);
      if (tracker) tracker.headers[String(name)] = String(value);
      return setRequestHeader.apply(this, arguments);
    };
    xhrPrototype.send = function(body) {
      const tracker = xhrTrackers.get(this);
      if (!tracker || !tracker.kind) return send.apply(this, arguments);
      let outgoing = body;
      if (typeof body === 'string') tracker.body = body;
      if (tracker.kind === 'update' && typeof body === 'string') {
        const patched = guardedBody(body);
        if (patched) {
          outgoing = patched;
          tracker.body = patched;
        }
      }
      if (tracker.kind === 'list') {
        pageInflight += 1;
        lastListSentAt = Date.now();
      }
      if (tracker.kind !== 'api') {
        // 只读 ListPrompts 的响应体；增删改请求只看状态码。
        this.addEventListener('loadend', () => {
          const ok = this.status >= 200 && this.status < 300;
          settle(tracker, ok, tracker.kind === 'list' ? responseText(this) : '');
        });
      }
      learn(tracker);
      if (outgoing === body) return send.apply(this, arguments);
      const args = Array.prototype.slice.call(arguments);
      args[0] = outgoing;
      return send.apply(this, args);
    };
  }

  async function readFetchBody(request, init) {
    if (init && typeof init.body === 'string') return init.body;
    if (request && typeof request.clone === 'function') return request.clone().text();
    return null;
  }

  if (typeof nativeFetch === 'function') {
    globalThis.fetch = function(input, init) {
      const request = input && typeof input === 'object' ? input : null;
      const method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
      const tracker = track(method, typeof input === 'string' ? input : (request && request.url) || '');
      try {
        new Headers((init && init.headers) || (request && request.headers) || undefined)
          .forEach((value, name) => { tracker.headers[name] = value; });
      } catch (_) {}
      if (init && typeof init.body === 'string') tracker.body = init.body;

      let callInit = init;
      const needsRequestUpdateGuard = tracker.kind === 'update' && titleGuards.size > 0 &&
        !(init && typeof init.body === 'string') && request && typeof request.clone === 'function';
      if (tracker.kind === 'update' && typeof tracker.body === 'string') {
        const patched = guardedBody(tracker.body);
        if (patched) {
          callInit = Object.assign({}, init, { body: patched });
          tracker.body = patched;
        }
      }
      const pending = needsRequestUpdateGuard
        ? request.clone().text().then(raw => {
            const patched = guardedBody(raw);
            if (!patched) return nativeFetch.call(this, input, init);
            tracker.body = patched;
            if (typeof Request === 'function' && input instanceof Request) {
              return nativeFetch.call(this, new Request(input, { body: patched }), init);
            }
            return nativeFetch.call(this, input, Object.assign({}, init, { body: patched }));
          }, () => nativeFetch.call(this, input, init))
        : nativeFetch.apply(this, callInit === init ? arguments : [input, callInit]);
      if (tracker.kind) {
        if (tracker.kind === 'list') {
          pageInflight += 1;
          lastListSentAt = Date.now();
        }
        learn(tracker);
        if (tracker.kind === 'list') {
          // 克隆响应必须在返回给调用方之前排队，否则调用方读完正文后就克隆不到了。
          const cloned = pending.then(response => {
            try { return response.clone(); } catch (_) { return null; }
          }, () => null);
          const bodyReady = tracker.body !== null
            ? Promise.resolve(tracker.body)
            : readFetchBody(request, init).then(body => {
                if (body !== null) {
                  tracker.body = body;
                  learn(tracker);
                }
                return body;
              }, () => null);
          bodyReady
            .then(() => cloned)
            .then(copy => {
              if (!copy) return settle(tracker, false, '');
              copy.text().then(text => settle(tracker, copy.ok, text), () => settle(tracker, copy.ok, ''));
            }, () => settle(tracker, false, ''));
        } else if (tracker.kind !== 'api') {
          pending.then(response => settle(tracker, response.ok, ''), () => settle(tracker, false, ''));
        }
      }
      return pending;
    };
  }

  // Angular 的站内跳转只调用 history.pushState / replaceState，不触发任何事件：包一层通知扩展世界。
  lastPath = location.pathname + location.search;
  const historyApi = globalThis.history;
  for (const name of ['pushState', 'replaceState']) {
    const original = historyApi && historyApi[name];
    if (typeof original !== 'function') continue;
    historyApi[name] = function() {
      const result = original.apply(this, arguments);
      const path = location.pathname + location.search;
      if (path !== lastPath) {
        lastPath = path;
        protocol.send(protocol.ROUTE, { path });
      }
      return result;
    };
  }

  protocol.receive(protocol.HELLO, onHello);
  protocol.receive(protocol.REQUEST, onRequest);
  protocol.receive(protocol.ACTION, runAction);
})();
