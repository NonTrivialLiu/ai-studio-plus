/* 由 scripts/build.mjs 生成，请勿手改：修改 extension/src 或 extension/styles 后运行 npm run build。 */
/* content.js ← src/protocol.js + src/history-store.js + src/sidebar-shared.js + src/sidebar-edit.js + src/sidebar-selection.js + src/sidebar-menu.js + src/sidebar.js + src/sidebar-space.js + src/nav-collapse.js + src/run-settings-peek.js + src/bubbles.js + src/main.js */
/**
 * AI Studio Plus - Protocol
 * MAIN 世界 (interceptor.js) 与 ISOLATED 世界 (content.js) 之间的消息信封。
 * 两个世界只共享 DOM、不共享 JavaScript 对象：CustomEvent.detail 跨世界读取时为 null，
 * 所以统一走 window.postMessage（结构化克隆），并用固定频道名互相辨认。
 */
globalThis.AIPProtocol = (() => {
  const CHANNEL = 'aistudio-plus:v1';

  // 页面自己刚送来一页数据后，先等这么久再决定要不要由扩展代取下一页：
  // 页面多半正在连续翻页 (如 History 页)，抢着发只会得到重复的一页。
  const PAGE_PACING_MS = 4000;
  const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

  // MAIN → ISOLATED
  const PAGE = 'prompts:page';              // { mode: 'replace' | 'append', items, hasMore, unrecognized, requestId }
  const ERROR = 'prompts:error';            // { code, requestId }
  const INVALIDATED = 'prompts:invalidated';  // {} 有会话被新建、改名或删除，列表需要重新同步
  const ROUTE = 'route:changed';            // { path }
  const RESULT = 'action:result';           // { requestId, action, ok, code? }  改名 / 复制 / 删除的结果

  // ISOLATED → MAIN
  const HELLO = 'hello';                    // {} ISOLATED 世界已就绪
  const REQUEST = 'prompts:request';        // { requestId, kind: 'next' | 'first' }
  const ACTION = 'action:request';          // { requestId, action: 'rename' | 'copy' | 'delete', id, title? }

  function collapseSpaces(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function isImeComposing(event) {
    return !!(event && (event.isComposing || event.keyCode === 229));
  }

  function send(type, payload) {
    window.postMessage({ channel: CHANNEL, type, payload: payload || {} }, location.origin);
  }

  // 只接收本窗口、同源、频道匹配的消息；payload 统一成普通对象，字段由使用方各自校验。
  function receive(type, handler) {
    const listener = event => {
      const data = event.data;
      if (event.source !== window || event.origin !== location.origin || !data || data.channel !== CHANNEL || data.type !== type) return;
      if (!data.payload || typeof data.payload !== 'object') return;
      handler(data.payload);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  return Object.freeze({
    PAGE, ERROR, INVALIDATED, ROUTE, RESULT, HELLO, REQUEST, ACTION,
    PAGE_PACING_MS, ID_PATTERN, collapseSpaces, isImeComposing, send, receive
  });
})();

/**
 * AI Studio Plus - History Store
 * ISOLATED 世界。会话状态的唯一来源：接收拦截器推送的页面数据并去重对账、按本地日历日分桶
 * (Today / Yesterday / Previous 7 days / Previous 30 days / Earlier)、管理分页状态与会话级缓存。
 * 只保留 { id, title, updatedAt } 三个字段，不接触作者、头像等其余信息。
 */
globalThis.AIPHistoryStore = (() => {
  const protocol = globalThis.AIPProtocol;
  const PAGE_PACING_MS = protocol.PAGE_PACING_MS;
  const ID = protocol.ID_PATTERN;
  const DAY_MS = 86400000;

  const CACHE_KEY = 'aistudio-plus:history:v1';
  const CACHE_LIMIT = 1000;          // 只缓存最近的一批，够"打开即呈现"即可
  const CACHE_DELAY_MS = 400;
  const REFRESH_COOLDOWN_MS = 3000;
  const STALE_AFTER_MS = 10 * 60 * 1000;

  const BUCKETS = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'week', label: 'Previous 7 days' },
    { key: 'month', label: 'Previous 30 days' },
    { key: 'earlier', label: 'Earlier' }
  ];

  const items = new Map();           // id → { id, title, updatedAt }
  const sequence = new Map();        // id → 入库序号：时间相同时保持稳定次序
  const listeners = new Set();
  let order = [];                    // 按 updatedAt 降序的 id
  let counter = 0;
  let query = '';
  let hasMore = true;                // 是否还可能有更早的会话
  let loading = false;
  let live = false;                  // 是否收到过页面的真实数据 (而非缓存)
  let error = null;                  // { code }
  let pending = null;                // { requestId, kind }：在途的分页请求
  let refreshQueued = false;
  let lastPageEventAt = 0;
  let lastLiveAt = 0;
  let lastRefreshAt = 0;
  let requestCounter = 0;
  let paceTimer = 0;
  let refreshTimer = 0;
  let deferredRefreshAt = 0;     // 冷却期内被推迟的那次同步是什么时候触发的
  let firstRequestedAt = 0;      // 最近一次真正发出的首页同步请求的时间
  let lastReplaceAt = 0;         // 最近一份首页数据能覆盖到的时间点
  let cacheTimer = 0;
  let cacheDirty = false;
  let view = null;

  // 1. 时间分桶 ---------------------------------------------------------------------------------

  // 两个时刻相隔几个本地日历日。用本地的年月日构造，避开夏令时当天只有 23 / 25 小时的坑。
  function dayDistance(timestamp, now) {
    const a = new Date(timestamp);
    const b = new Date(now);
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
  }

  // 按日历日判断，一条会话全天待在同一个分组里，不会随着时间流逝在组间漂移。
  function bucketOf(timestamp, now) {
    if (!timestamp) return 'earlier';
    const days = dayDistance(timestamp, now);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days <= 7) return 'week';
    if (days <= 30) return 'month';
    return 'earlier';
  }

  // 2. 合并对账 ---------------------------------------------------------------------------------

  function sanitize(raw) {
    if (!raw || typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
    return {
      id: raw.id,
      title: typeof raw.title === 'string' ? protocol.collapseSpaces(raw.title) : '',
      updatedAt: Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : null
    };
  }

  function compare(a, b) {
    return (b.updatedAt || 0) - (a.updatedAt || 0) || sequence.get(a.id) - sequence.get(b.id);
  }

  function merge(list, authoritative) {
    const seen = new Set();
    let floor = Infinity;
    for (const raw of list) {
      const item = sanitize(raw);
      if (!item) continue;
      const known = items.get(item.id);
      if (known) {
        known.title = item.title;
        known.updatedAt = item.updatedAt;
      } else {
        sequence.set(item.id, counter++);
        items.set(item.id, item);
      }
      seen.add(item.id);
      if (item.updatedAt) floor = Math.min(floor, item.updatedAt);
    }
    if (authoritative) {
      // 首页是服务端按更新时间排好序的权威前缀：落在这个时间范围内、却不在首页里的会话，
      // 说明已经被删除 (或有了新活动而挪到了首页里)。空首页即"没有任何会话"。
      if (!list.length) {
        items.clear();
        sequence.clear();
      } else if (floor !== Infinity) {
        for (const [id, item] of items) {
          if (!seen.has(id) && item.updatedAt && item.updatedAt >= floor) {
            items.delete(id);
            sequence.delete(id);
          }
        }
      }
    }
    order = Array.from(items.values()).sort(compare).map(item => item.id);
    cacheDirty = true;
  }

  // 3. 派生视图 ---------------------------------------------------------------------------------

  function buildView() {
    const now = Date.now();
    const groups = [];
    let shown = 0;
    let group = null;
    for (let i = 0; i < order.length; i++) {
      const item = items.get(order[i]);
      if (query && !item.title.toLowerCase().includes(query)) continue;
      shown += 1;
      const key = bucketOf(item.updatedAt, now);
      if (!group || group.key !== key) {
        group = { key, label: BUCKETS.find(bucket => bucket.key === key).label, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    // ids：当前全部会话 (含被搜索过滤掉的)。侧栏靠它分辨"被过滤"与"已删除"。
    // pageEventAt：页面自己最近一次送来分页数据的时刻，侧栏据此判断它是否还在连续翻页。
    return {
      groups, total: items.size, shown, query, hasMore, loading, error, live,
      ids: new Set(items.keys()), pageEventAt: lastPageEventAt
    };
  }

  function getView() {
    if (!view) view = buildView();
    return view;
  }

  function notify() {
    view = null;
    const next = getView();
    scheduleSave();
    listeners.forEach(listener => listener(next));
    autoload();
  }

  // 搜索要覆盖全部历史：有关键字而列表还没取完时，在后台继续往下取。
  function autoload() {
    clearTimeout(paceTimer);
    if (!live || !query || !hasMore || loading || error) return;
    const wait = PAGE_PACING_MS - (Date.now() - lastPageEventAt);
    if (wait > 0) paceTimer = setTimeout(autoload, wait);
    else request('next');
  }

  // 4. 分页状态机 -------------------------------------------------------------------------------

  function request(kind) {
    if (pending) {
      if (kind === 'first') refreshQueued = true;
      return false;
    }
    const requestId = 'r' + (++requestCounter);
    pending = { requestId, kind };
    loading = true;
    error = null;
    if (kind === 'first') firstRequestedAt = Date.now();
    notify();
    protocol.send(protocol.REQUEST, { requestId, kind });
    return true;
  }

  function canLoad() {
    return live && hasMore && !loading && !error;
  }

  // 立即取下一页。"要不要取" (用户是否滚到了底部、页面是否正在自己翻页) 由调用方判断：
  // 仓库不知道滚动位置，替它猜就会在每次打开页面时多发一次请求。
  function loadMore() {
    return canLoad() && request('next');
  }

  // 重新同步首页。短时间内多次触发合并成一次；冷却期内又来了变更，就等冷却结束再补一次，
  // 而不是把它丢掉。
  function refresh() {
    const wait = REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt);
    if (wait > 0) {
      deferredRefreshAt = Date.now();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, wait);
      return false;
    }
    lastRefreshAt = Date.now();
    return request('first');
  }

  // 一次首页同步覆盖的是它发出之前的全部变更。被推迟的那次同步如果已经被更新的首页数据覆盖
  // (自己发出的看发出时间，页面自己送来的看到达时间)，就没有必要再补。
  function coverDeferredRefresh() {
    if (!deferredRefreshAt || lastReplaceAt < deferredRefreshAt) return;
    deferredRefreshAt = 0;
    clearTimeout(refreshTimer);
  }

  function flushQueued() {
    if (refreshQueued && !pending) {
      refreshQueued = false;
      request('first');
    }
  }

  function onPage(payload) {
    const reply = pending && payload.requestId === pending.requestId;
    if (reply) {
      pending = null;
      loading = false;
    }
    if (payload.requestId == null) lastPageEventAt = Date.now();
    lastLiveAt = Date.now();
    live = true;
    error = null;
    if (payload.mode === 'replace') {
      lastReplaceAt = reply ? firstRequestedAt : lastPageEventAt;
      coverDeferredRefresh();
    }
    merge(Array.isArray(payload.items) ? payload.items : [], payload.mode === 'replace');
    if (typeof payload.hasMore === 'boolean') hasMore = payload.hasMore;
    if (payload.mode === 'replace' && payload.unrecognized > 0 && !items.size) error = { code: 'unrecognized' };
    notify();
    flushQueued();
  }

  function onError(payload) {
    const reply = pending && payload.requestId === pending.requestId;
    if (reply) {
      pending = null;
      loading = false;
      refreshQueued = false;
    }
    // 手里已有会话时，页面侧的解析失败不打扰使用；只在还什么都没显示出来时提示。
    if (!reply && items.size) return;
    error = { code: typeof payload.code === 'string' ? payload.code : 'unknown' };
    notify();
  }

  protocol.receive(protocol.PAGE, onPage);
  protocol.receive(protocol.ERROR, onError);
  protocol.receive(protocol.INVALIDATED, refresh);

  // 5. 会话级缓存 -------------------------------------------------------------------------------

  function loadCache() {
    let raw = null;
    try {
      raw = sessionStorage.getItem(CACHE_KEY);
    } catch (_) {
      return;
    }
    let saved = null;
    try {
      saved = JSON.parse(raw);
    } catch (_) {}
    if (saved && saved.v === 1 && Array.isArray(saved.items)) merge(saved.items, false);
  }

  function scheduleSave() {
    if (!cacheDirty || cacheTimer) return;
    cacheTimer = setTimeout(() => {
      cacheTimer = 0;
      if (!cacheDirty) return;
      cacheDirty = false;
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({
          v: 1,
          savedAt: Date.now(),
          items: order.slice(0, CACHE_LIMIT).map(id => items.get(id))
        }));
      } catch (_) {
        cacheDirty = true;   // 写不进去 (配额、隐私模式) 下次再试
      }
    }, CACHE_DELAY_MS);
  }

  // 6. 对外接口 ---------------------------------------------------------------------------------

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    view = null;             // 页面挂了一夜，跨过零点后要重新分桶
    notify();
    if (live && Date.now() - lastLiveAt > STALE_AFTER_MS) refresh();
  });

  loadCache();
  cacheDirty = false;        // 缓存读出来是什么样就还是什么样，不必原样写回去
  protocol.send(protocol.HELLO, {});

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(getView());
      return () => listeners.delete(listener);
    },
    getView,
    // 某个会话此刻的标题 (没有标题的是空串)；不在列表里时返回 null。
    titleOf(id) {
      const item = items.get(id);
      return item ? item.title : null;
    },
    setQuery(value) {
      const next = protocol.collapseSpaces(value).toLowerCase();
      if (next === query) return;
      query = next;
      notify();
    },
    loadMore,
    retry() {
      error = null;
      notify();
    },
    refresh,
    // 当前打开的会话不在列表里 (多半是刚新建的)：请拦截器重新同步首页。
    noteCurrentPrompt(id) {
      if (id && live && !items.has(id)) refresh();
    },
    // 改名后先在本地立即生效，随后拦截器会送来权威的首页数据。
    rename(id, title) {
      const item = items.get(id);
      if (!item || item.title === title) return false;
      item.title = title;
      cacheDirty = true;
      notify();
      return true;
    },
    // 删除成功后立即移除。
    remove(id) {
      if (!items.delete(id)) return false;
      sequence.delete(id);
      order = order.filter(key => key !== id);
      cacheDirty = true;
      notify();
      return true;
    },
    // 兜底注入完成后调用：让主世界知道这边已经就绪，补发错过的首页。
    hello() {
      protocol.send(protocol.HELLO, {});
    }
  };
})();

/**
 * AI Studio Plus - Sidebar Shared
 * ISOLATED 世界。侧栏模块共用的常量、文案字典、DOM/路由/状态辅助与拦截器 RPC 工具。
 * 挂载到 globalThis.__AIPSidebarParts.shared，由 sidebar.js 组装后统一清理。
 */
globalThis.__AIPSidebarParts = globalThis.__AIPSidebarParts || {};

globalThis.__AIPSidebarParts.shared = (() => {
  const protocol = globalThis.AIPProtocol;
  const NAV = 'ms-navbar-v2', LIST = 'ms-nav-items-main-v2';
  const ROUTE = /^\/prompts\/(?!new_chat(?:\/|$))([A-Za-z0-9_-]{1,128})(?:[/?#]|$)/;
  const PAGE_PACING_MS = protocol.PAGE_PACING_MS;
  const PREFETCH_PX = 480, SEARCH_DEBOUNCE_MS = 120, LONG_PRESS_MS = 500, LONG_PRESS_DISTANCE = 8;
  const NOTICE_MS = 4500, ACTION_TIMEOUT_MS = 45000, SHARE_WAIT_MS = 15000, STICKY_TITLE_PX = 24;
  const NATIVE_ITEM = 'ms-button-borderless';
  const FOREIGN = '[class*="gv-"], [id^="gv-"], [data-gv-component], [data-gv-layer], [data-gv-plugin]';
  const EDIT_TITLE_BUTTON = 'button[aria-label="Edit prompt title and description"]';
  const NAV_WIDTH_PX = 220, HEADER_BAND_PX = 64;

  const TEXT = {
    history: 'Chat history', chatList: 'Chat list', search: 'Search', clear: 'Clear',
    newChat: 'New chat', drawer: 'Explore & Build & Manage', drawerExplore: 'Explore', drawerHistory: 'History',
    untitled: 'Untitled chat', loading: 'Loading chats…', loadingMore: 'Loading more…',
    searching: 'Searching older chats…', done: 'End of history', empty: 'No chats yet',
    noMatch: 'No matching chats', retry: 'Retry', rename: 'Rename chat', emptyTitle: 'Enter a title',
    more: 'More options', menu: 'Chat actions', busy: 'Working — try again in a moment',
    confirmTitle: 'Move to trash?', confirmBody: 'It will be permanently deleted after 30 days.',
    confirmBodies: 'They will be permanently deleted after 30 days.', confirmCancel: 'Cancel', confirmDelete: 'Delete',
    renamed: 'Renamed', copied: 'Copy created', copyPrefix: 'Copy of ',
    copyUnknown: 'Copy status is unknown — check your chats before trying again',
    deleted: 'Moved to trash. Restore it from Google Drive within 30 days.',
    selectChats: 'Select chats', exitSelection: 'Exit selection',
    selectRow: title => `Select ${title}`,
    selectedCount: (count, hidden) => (hidden ? `${count} selected (${hidden} hidden)` : `${count} selected`),
    uncertainTitle: 'Refresh History or deselect chats with unknown results before retrying.',
    batchTitle: count => `Move ${count} ${count === 1 ? 'chat' : 'chats'} to trash?`,
    batchHidden: hidden => `${hidden} selected ${hidden === 1 ? 'chat is' : 'chats are'} hidden by search.`,
    batchOpenIncluded: 'The open chat is included.',
    deletingProgress: (index, total) => `Deleting ${index}/${total}…`,
    batchDeleted: count => `${count} ${count === 1 ? 'chat' : 'chats'} moved to trash.`,
    batchPartialUnknown: count => `${count} moved to trash. Some results are unknown; refresh History before retrying.`,
    batchPartialFailed: (removed, failed) => `${removed} moved to trash; ${failed} failed. Select Delete to retry.`,
    errors: {
      network: "Couldn't load chats — check your connection", http: "Couldn't load chats",
      unauthorized: 'Your session expired — refresh the page', 'rate-limited': 'Too many requests — try again shortly',
      unrecognized: 'AI Studio changed its chat list — this extension needs an update', unknown: "Couldn't load chats"
    },
    failed: {
      rename: "Couldn't rename this chat", copy: "Couldn't make a copy",
      delete: "Couldn't delete this chat", share: "Couldn't open Share — use the History menu"
    },
    reason: {
      network: 'check your connection and try again', timeout: 'it took too long, so try again',
      unauthorized: 'your session expired, so refresh the page', 'rate-limited': 'too many requests, so try again shortly',
      'not-found': 'it no longer exists', unparseable: "AI Studio's response wasn't recognized",
      invalid: "that title can't be used", unknown: 'try again'
    }
  };

  const MENU = [
    { action: 'rename', label: 'Rename', icon: 'edit' },
    { action: 'share', label: 'Share', icon: 'share' },
    { action: 'copy', label: 'Make a copy', icon: 'content_copy' },
    { action: 'select', label: 'Select', icon: 'checklist' },
    { action: 'delete', label: 'Delete', icon: 'delete' }
  ];

  function element(tag, className, text, attrs, children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'role' || key.includes('-')) node.setAttribute(key, value);
        else node[key] = value;
      }
    }
    if (children) node.append(...children);
    return node;
  }

  const icon = (name, className) => element(
    'span', className ? `material-symbols-outlined notranslate ${className}` : 'material-symbols-outlined notranslate',
    name, { 'aria-hidden': 'true' }
  );
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rowOf = (target, selector) => (target instanceof Element ? target.closest(selector) : null);
  const linkOf = row => row?.querySelector('.aip-row-link') || null;
  const menuButtonOf = row => row?.querySelector('.aip-row-menu') || null;
  const checkboxOf = row => row?.querySelector('.aip-row-checkbox') || null;
  const rowTitle = row => linkOf(row)?.title || '';
  const isComposing = event => (protocol.isImeComposing ? protocol.isImeComposing(event) : !!(event && (event.isComposing || event.keyCode === 229)));

  function place(parent, node, previous) {
    const target = previous ? previous.nextSibling : parent.firstChild;
    if (target !== node) parent.insertBefore(node, target);
  }

  function exploreAnchor(list) {
    const link = list.querySelector('a[href="/prompts/new_chat"], a[href="/library"]');
    for (let node = link; node; node = node.parentElement) if (node.parentElement === list) return node;
    return null;
  }

  function captureAnchor(scroll) {
    if (scroll.scrollTop <= 0) return null;
    const top = scroll.getBoundingClientRect().top;
    for (const row of scroll.querySelectorAll('.aip-row')) {
      if (row.hidden) continue;
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top) return { row, offset: rect.top - top };
    }
    return null;
  }

  function restoreAnchor(scroll, anchor) {
    if (!anchor || !anchor.row.isConnected || anchor.row.hidden) return;
    const shift = anchor.row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
    if (shift) scroll.scrollTop += shift;
  }

  function reveal(scroll, row) {
    const box = scroll.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < box.top + STICKY_TITLE_PX) scroll.scrollTop += rect.top - box.top - STICKY_TITLE_PX;
    else if (rect.bottom > box.bottom) scroll.scrollTop += rect.bottom - box.bottom;
  }

  function statusFor(view) {
    if (view.error) {
      const text = TEXT.errors[view.error.code] || TEXT.errors.unknown;
      return view.error.code === 'no-template' ? { kind: 'waiting', text: TEXT.loading, spinner: true } : { kind: 'error', text, retry: true };
    }
    if (!view.live) return { kind: 'waiting', text: TEXT.loading, spinner: true };
    if (view.loading) return { kind: 'loading', text: view.query ? TEXT.searching : TEXT.loadingMore, spinner: true };
    if (!view.shown) return { kind: 'empty', text: view.total ? TEXT.noMatch : TEXT.empty };
    return view.hasMore ? { kind: 'idle', text: '' } : { kind: 'done', text: TEXT.done };
  }

  function navigate(url) {
    const target = new URL(url, location.href);
    if (target.pathname === location.pathname && target.search === location.search) return;
    try {
      history.pushState(history.state, '', target.href);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } catch (_) { location.href = target.href; }
  }

  function currentPromptId() {
    const match = ROUTE.exec(location.pathname);
    return match ? match[1] : null;
  }

  // 优先在触发点右侧展开，空间不足时切到左侧并限制在可视区域内。
  function positionPopup(panel, anchor) {
    const width = panel.offsetWidth, height = panel.offsetHeight, margin = 4;
    const right = anchor.right + margin;
    const left = right + width <= window.innerWidth - margin ? right : anchor.left - width - margin;
    panel.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`;
    panel.style.top = `${Math.max(margin, Math.min(anchor.top, window.innerHeight - height - margin))}px`;
  }

  function requestAction(state, action, extra) {
    return new Promise(resolve => {
      const requestId = `a${++state.actionSeq}`;
      let settled = false;
      const stop = protocol.receive(protocol.RESULT, payload => {
        if (payload.requestId !== requestId || settled) return;
        settled = true; clearTimeout(timer); stop();
        resolve({ ok: payload.ok === true, code: payload.ok === true ? null : (payload.code || 'unknown') });
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true; stop();
        resolve({ ok: false, code: 'timeout' });
      }, ACTION_TIMEOUT_MS);
      protocol.send(protocol.ACTION, Object.assign({ requestId, action }, extra));
    });
  }

  function failure(action, code) {
    if (action === 'copy' && (code === 'timeout' || code === 'network')) return TEXT.copyUnknown;
    return `${TEXT.failed[action]} — ${TEXT.reason[code] || TEXT.reason.unknown}.`;
  }

  function notice(state, text, kind) {
    clearTimeout(state.noticeTimer);
    state.notice.textContent = text;
    state.notice.dataset.kind = kind;
    state.notice.hidden = false;
    state.noticeTimer = setTimeout(() => { state.notice.hidden = true; }, NOTICE_MS);
  }

  function patchPageTitle(from, to) {
    const header = document.querySelector('ms-header') || document.querySelector('ms-app');
    if (header) {
      const edit = document.querySelector(EDIT_TITLE_BUTTON);
      const edge = edit ? edit.getBoundingClientRect().left : Infinity;
      for (const node of header.querySelectorAll('*')) {
        if (node.children.length || node.textContent !== from) continue;
        const rect = node.getBoundingClientRect();
        if (rect.top >= 0 && rect.bottom <= HEADER_BAND_PX && rect.left >= NAV_WIDTH_PX && rect.right <= edge) node.textContent = to;
      }
    }
    if (from && document.title.startsWith(from)) document.title = to + document.title.slice(from.length);
  }

  return {
    NAV, LIST, ROUTE, PAGE_PACING_MS, PREFETCH_PX, SEARCH_DEBOUNCE_MS, LONG_PRESS_MS, LONG_PRESS_DISTANCE,
    NOTICE_MS, ACTION_TIMEOUT_MS, SHARE_WAIT_MS, STICKY_TITLE_PX, NATIVE_ITEM, FOREIGN, EDIT_TITLE_BUTTON,
    NAV_WIDTH_PX, HEADER_BAND_PX, TEXT, MENU, element, icon, delay, rowOf, linkOf, menuButtonOf,
    checkboxOf, rowTitle, isComposing, place, exploreAnchor, captureAnchor, restoreAnchor, reveal,
    statusFor, navigate, currentPromptId, positionPopup, requestAction, failure, notice, patchPageTitle
  };
})();

/**
 * AI Studio Plus - Sidebar Inline Rename
 * ISOLATED 世界。负责历史会话行的原位重命名：双击 / F2 / 菜单触发，
 * Enter 提交、Esc 取消、失焦保存，并处理 IME 组字态与无标题会话重命名。
 */
globalThis.__AIPSidebarParts = globalThis.__AIPSidebarParts || {};

globalThis.__AIPSidebarParts.createEdit = function createEdit(ctx) {
  const {
    TEXT, element, linkOf, isComposing, currentPromptId, requestAction, failure, patchPageTitle
  } = globalThis.__AIPSidebarParts.shared;
  const { state, store } = ctx;

  function startEdit(row, select) {
    if (state.edit) {
      if (state.edit.row === row) return;
      commitEdit(state.edit);
      return;
    }
    ctx.menu.closeMenu();
    const id = row.dataset.id;
    const link = linkOf(row);
    if (!link) return;
    const input = element('input', 'aip-row-edit');
    input.type = 'text';
    input.value = link.title;
    input.setAttribute('aria-label', TEXT.rename);
    input.autocomplete = 'off';
    input.spellcheck = false;
    row.classList.add('is-editing');
    link.hidden = true;
    row.appendChild(input);
    const original = store.titleOf(id) ?? '';
    state.edit = { id, row, input, original, before: link.title, hadTitle: original !== '', saving: false };
    input.addEventListener('keydown', onEditKeydown);
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    input.focus({ preventScroll: true });
    if (select) input.select();
  }

  // 把一行恢复成普通行。之前它是否在保存不受影响：请求的结果回来后由 commitEdit 收尾。
  function teardownEdit(edit) {
    edit.input.remove();
    edit.row.classList.remove('is-editing');
    const link = linkOf(edit.row);
    if (link) link.hidden = false;
    ctx.syncRow(edit.row, { title: store.titleOf(edit.id) ?? edit.before });
  }

  function endEdit() {
    const edit = state.edit;
    if (!edit) return;
    const refocus = document.activeElement === edit.input;   // 只有焦点还在输入框里 (Enter / Esc) 才归还焦点
    state.edit = null;
    teardownEdit(edit);
    if (refocus) linkOf(edit.row)?.focus({ preventScroll: true });
  }

  function cancelEdit() {
    const edit = state.edit;
    if (!edit) return;
    store.rename(edit.id, edit.original);
    endEdit();
  }

  function onEditKeydown(event) {
    if (isComposing(event)) return;                          // 输入法组字选词：保持编辑状态
    if (state.edit?.saving) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit(state.edit);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  }

  function onEditBlur(event) {
    const edit = state.edit;
    if (edit && edit.input === event.target && !edit.saving) commitEdit(edit);
  }

  async function commitEdit(edit) {
    if (!edit || state.edit !== edit || edit.saving) return;
    const title = edit.input.value.replace(/\s+/g, ' ').trim();
    if (!title) {
      edit.input.setAttribute('aria-invalid', 'true');
      ctx.notice(TEXT.emptyTitle, 'error');
      return;
    }
    if (title === edit.before && edit.hadTitle) return endEdit();
    const wasOpen = currentPromptId() === edit.id;
    edit.saving = true;
    state.busy = true;
    edit.input.readOnly = true;
    edit.input.setAttribute('aria-busy', 'true');
    store.rename(edit.id, title);                              // 先按新标题显示
    const outcome = await requestAction(state, 'rename', { id: edit.id, title });
    state.busy = false;
    if (!outcome.ok) store.rename(edit.id, edit.original);     // 没保存成功：列表里改回原名
    if (state.edit !== edit) return;                           // 期间这一行已经退出了编辑
    edit.saving = false;
    edit.input.readOnly = false;
    edit.input.removeAttribute('aria-busy');
    if (outcome.ok) {
      if (wasOpen) patchPageTitle(edit.before, title);
      endEdit();
      ctx.notice(TEXT.renamed, 'ok');
    } else {
      ctx.notice(failure('rename', outcome.code), 'error');
    }
  }

  return { startEdit, teardownEdit, endEdit, cancelEdit, onEditKeydown, onEditBlur, commitEdit };
};

/**
 * AI Studio Plus - Sidebar Multi-Select & Batch Delete
 * ISOLATED 世界。负责长按进入多选、选中状态渲染、键盘快捷键与批量删除确认流，
 * 包括搜索隐藏项计数与网络超时后的不确定项隔离。
 */
globalThis.__AIPSidebarParts = globalThis.__AIPSidebarParts || {};

globalThis.__AIPSidebarParts.createSelection = function createSelection(ctx) {
  const {
    LONG_PRESS_MS, LONG_PRESS_DISTANCE, TEXT, element, rowOf, linkOf, checkboxOf,
    isComposing, navigate, currentPromptId, positionPopup, requestAction
  } = globalThis.__AIPSidebarParts.shared;
  const { state, store } = ctx;

  function hiddenSelectedCount() {
    if (!state.selected.size || !state.view) return 0;
    const shown = new Set(state.view.groups.flatMap(group => group.items.map(item => item.id)));
    let hidden = 0;
    for (const id of state.selected) {
      if (!shown.has(id)) hidden += 1;
    }
    return hidden;
  }

  // 多选状态独立于当前会话；搜索只过滤显示，不改变选中的 ID。
  function renderSelection() {
    if (!state.root) return;
    state.root.classList.toggle('is-selecting', state.selecting);
    state.selectStart.hidden = state.selecting;
    state.selectStart.disabled = !state.view?.shown;
    state.selectionBar.hidden = !state.selecting;
    state.selectionCount.textContent = TEXT.selectedCount(state.selected.size, hiddenSelectedCount());
    state.selectionDelete.disabled = !state.selected.size || state.busy || state.uncertain.size > 0;
    state.selectionDelete.title = state.uncertain.size ? TEXT.uncertainTitle : '';
    state.selectionExit.disabled = state.busy;
    for (const [id, row] of state.rows) {
      const checkbox = checkboxOf(row);
      if (checkbox) {
        checkbox.checked = state.selected.has(id);
        checkbox.disabled = state.busy;
        checkbox.tabIndex = state.selecting ? 0 : -1;
      }
      const link = linkOf(row);
      if (link) link.tabIndex = state.selecting ? -1 : 0;
      if (state.uncertain.has(id)) row.dataset.uncertain = 'true';
      else delete row.dataset.uncertain;
    }
  }

  function enterSelection(id) {
    if (state.busy) return ctx.notice(TEXT.busy, 'error');
    if (state.edit) {
      ctx.edit.commitEdit(state.edit);
      return;
    }
    ctx.menu.closeMenu();
    state.selecting = true;
    if (id) state.selected.add(id);
    renderSelection();
    (id ? checkboxOf(state.rows.get(id)) : state.selectionExit)?.focus({ preventScroll: true });
  }

  function exitSelection() {
    if (state.busy) return;
    closeBatchDialog(false);
    state.selecting = false;
    state.selected.clear();
    state.uncertain.clear();
    renderSelection();
    (state.selectStart.disabled ? state.input : state.selectStart).focus({ preventScroll: true });
  }

  function setSelected(id, selected) {
    if (state.busy) return;
    if (selected) state.selected.add(id);
    else {
      state.selected.delete(id);
      state.uncertain.delete(id);
    }
    renderSelection();
  }

  // 长按达到阈值即选中；保留这次指针序列，直到松手或取消。
  function onPressStart(event) {
    if (state.selecting || state.edit || state.busy || event.button !== 0 || event.isPrimary === false ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !rowOf(event.target, '.aip-row-link')) return;
    cancelPress();
    const row = rowOf(event.target, '.aip-row');
    if (!row) return;
    const gesture = { row, pointerId: event.pointerId, x: event.clientX, y: event.clientY, activated: false };
    state.root.classList.add('is-pressing');
    row.classList.add('is-pressing');
    gesture.timer = setTimeout(() => {
      if (state.gesture !== gesture || !row.isConnected || state.selecting || state.edit || state.busy) return cancelPress();
      gesture.activated = true;
      state.root?.classList.remove('is-pressing');
      row.classList.remove('is-pressing');
      enterSelection(row.dataset.id);
    }, LONG_PRESS_MS);
    state.gesture = gesture;
  }

  function cancelPress() {
    const gesture = state.gesture;
    if (!gesture) return;
    clearTimeout(gesture.timer);
    gesture.row?.classList.remove('is-pressing');
    state.root?.classList.remove('is-pressing');
    state.gesture = null;
  }

  function onPressMove(event) {
    const gesture = state.gesture;
    if (gesture && !gesture.activated && event.pointerId === gesture.pointerId &&
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > LONG_PRESS_DISTANCE) cancelPress();
  }

  function onPressScroll() {
    if (state.gesture && !state.gesture.activated) cancelPress();
  }

  function onPressEnd(event) {
    const gesture = state.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (event.type === 'pointerup' && gesture.activated) {
      const suppressed = { pointerId: gesture.pointerId, row: gesture.row };
      state.suppressClick = suppressed;
      setTimeout(() => { if (state.suppressClick === suppressed) state.suppressClick = null; }, 700);
    }
    cancelPress();
  }

  function suppressLongPressClick(event) {
    const suppressed = state.suppressClick;
    if (!suppressed || event.detail === 0) return;
    const samePointer = typeof event.pointerId === 'number' && event.pointerId >= 0
      ? event.pointerId === suppressed.pointerId
      : event.composedPath().includes(suppressed.row);
    if (!samePointer) return;
    state.suppressClick = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onSelectionKeydown(event) {
    if (!state.selecting || isComposing(event)) return;
    if (event.key === 'Escape' && !state.busy) {
      event.preventDefault();
      exitSelection();
    } else if (event.key === 'Delete' && !event.target.matches('input:not([type="checkbox"]), textarea, [contenteditable="true"]') && !state.selectionDelete.disabled) {
      event.preventDefault();
      confirmBatchDelete();
    }
  }

  function closeBatchDialog(restoreFocus = true) {
    const dialog = state.batchDialog;
    if (!dialog) return;
    state.batchDialog = null;
    const refocus = restoreFocus && dialog.contains(document.activeElement) && state.selectionDelete?.isConnected;
    dialog.remove();
    if (refocus) state.selectionDelete.focus({ preventScroll: true });
  }

  // 确认框沿用单项删除的面板和按钮样式，明确包含被搜索隐藏的选择。
  function confirmBatchDelete() {
    if (!state.selecting || !state.selected.size || state.busy || state.uncertain.size || state.batchDialog) return;
    ctx.menu.closeMenu(undefined, false);
    const count = state.selected.size;
    const hidden = hiddenSelectedCount();
    const panel = element('div', 'aip-menu aip-batch-dialog');
    const title = element('div', 'aip-menu-confirm-title', TEXT.batchTitle(count));
    title.id = 'aip-batch-dialog-title';
    const desc = element('div', 'aip-menu-confirm-desc');
    desc.id = 'aip-batch-dialog-desc';
    desc.appendChild(element('div', 'aip-menu-confirm-text', count === 1 ? TEXT.confirmBody : TEXT.confirmBodies));
    if (hidden) desc.appendChild(element('div', 'aip-menu-confirm-text', TEXT.batchHidden(hidden)));
    if (state.selected.has(currentPromptId())) desc.appendChild(element('div', 'aip-menu-confirm-text', TEXT.batchOpenIncluded));

    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-labelledby', title.id);
    panel.setAttribute('aria-describedby', desc.id);

    const box = element('div', 'aip-menu-confirm');
    const actions = element('div', 'aip-menu-confirm-actions');
    const cancel = element('button', 'aip-menu-button', TEXT.confirmCancel);
    const remove = element('button', 'aip-menu-button aip-menu-button-danger', TEXT.confirmDelete);
    cancel.type = remove.type = 'button';
    cancel.dataset.action = 'cancel';
    remove.dataset.action = 'confirm';
    cancel.addEventListener('click', () => closeBatchDialog(true));
    remove.addEventListener('click', deleteSelected);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeBatchDialog(true);
      } else if (event.key === 'Tab' && (document.activeElement === cancel || document.activeElement === remove)) {
        event.preventDefault();
        (document.activeElement === cancel ? remove : cancel).focus();
      }
    });
    actions.append(cancel, remove);
    box.append(title, desc, actions);
    panel.appendChild(box);
    document.body.appendChild(panel);
    state.batchDialog = panel;
    positionPopup(panel, state.selectionDelete.getBoundingClientRect());
    cancel.focus({ preventScroll: true });
  }

  async function deleteSelected() {
    if (state.busy || !state.batchDialog) return;
    const ids = Array.from(state.selected);
    const active = currentPromptId();
    let removed = 0;
    let failed = 0;
    let removedActive = false;
    closeBatchDialog(false);
    state.busy = true;
    renderSelection();
    for (const [index, id] of ids.entries()) {
      state.selectionCount.textContent = TEXT.deletingProgress(index + 1, ids.length);
      const outcome = await requestAction(state, 'delete', { id });
      if (outcome.ok) {
        state.selected.delete(id);
        state.uncertain.delete(id);
        removed += 1;
        removedActive ||= id === active;
        store.remove(id);
      } else {
        failed += 1;
        if (outcome.code === 'timeout' || outcome.code === 'network') state.uncertain.add(id);
      }
    }
    state.busy = false;
    if (state.uncertain.size) store.refresh();
    if (removedActive) navigate('/library');
    if (!failed) {
      exitSelection();
      ctx.notice(TEXT.batchDeleted(removed), 'ok');
    } else {
      renderSelection();
      state.selectionExit.focus({ preventScroll: true });
      ctx.notice(
        state.uncertain.size ? TEXT.batchPartialUnknown(removed) : TEXT.batchPartialFailed(removed, failed),
        'error'
      );
    }
  }

  return {
    renderSelection, enterSelection, exitSelection, setSelected,
    onPressStart, onPressMove, cancelPress, onPressEnd, onPressScroll,
    suppressLongPressClick, onSelectionKeydown, closeBatchDialog, confirmBatchDelete, deleteSelected
  };
};

/**
 * AI Studio Plus - Sidebar Context Menu
 * ISOLATED 世界。负责行尾三点菜单、菜单定位、单项删除确认弹窗、
 * 焦点迁移以及复用 History 页的分享动作。
 */
globalThis.__AIPSidebarParts = globalThis.__AIPSidebarParts || {};

globalThis.__AIPSidebarParts.createMenu = function createMenu(ctx) {
  const {
    MENU, SHARE_WAIT_MS, TEXT, element, icon, delay, rowOf, linkOf, menuButtonOf, rowTitle,
    navigate, currentPromptId, positionPopup, requestAction, failure
  } = globalThis.__AIPSidebarParts.shared;
  const { state, store } = ctx;

  function openMenu(row, anchor) {
    if (state.menu && state.menu.row === row) return closeMenu();
    closeMenu();
    ctx.selection.closeBatchDialog(false);
    const button = menuButtonOf(row);
    if (!button) return;
    const panel = element('div', 'aip-menu');
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', TEXT.menu);
    for (const item of MENU) {
      const entry = element('button', 'aip-menu-item');
      entry.type = 'button';
      entry.tabIndex = -1;               // 菜单内用方向键移动，见下面的 keydown
      entry.setAttribute('role', 'menuitem');
      entry.dataset.action = item.action;
      entry.append(icon(item.icon, 'aip-menu-icon'), element('span', 'aip-menu-text', item.label));
      panel.appendChild(entry);
    }
    panel.addEventListener('click', event => {
      const entry = rowOf(event.target, '[data-action]');
      if (!entry) return;
      const action = entry.dataset.action;
      if (action === 'delete') return renderConfirm();
      if (action === 'cancel') return closeMenu(undefined, true);
      runMenuAction(action === 'confirm' ? 'delete' : action);
    });
    panel.addEventListener('keydown', event => {
      const isConfirm = panel.getAttribute('role') === 'alertdialog';
      const entries = Array.from(panel.querySelectorAll('[data-action]'));
      const index = entries.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(undefined, true);
      } else if (!isConfirm && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        entries[(index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus();
      } else if (event.key === 'Tab') {
        if (isConfirm && entries.length >= 2) {
          event.preventDefault();
          const next = event.shiftKey ? (index <= 0 ? entries.length - 1 : index - 1) : (index + 1) % entries.length;
          entries[next]?.focus();
        } else {
          closeMenu(undefined, false);  // 焦点就要移出面板：收起菜单，不拦 Tab
        }
      }
    });
    document.body.appendChild(panel);
    state.menu = { panel, row, button, id: row.dataset.id, title: rowTitle(row), anchor };
    button.setAttribute('aria-expanded', 'true');
    positionMenu();
    panel.firstElementChild.focus({ preventScroll: true });
  }

  function positionMenu() {
    if (!state.menu) return;
    positionPopup(state.menu.panel, state.menu.anchor);
  }

  // 关闭菜单。row 给定时只关这一行的菜单；focus=false 用于焦点本来就要去别处的情况。
  function closeMenu(row, focus = true) {
    const menu = state.menu;
    if (!menu || (row && menu.row !== row)) return;
    state.menu = null;
    const refocus = focus && menu.panel.contains(document.activeElement) && menu.button.isConnected;
    menu.button.setAttribute('aria-expanded', 'false');
    menu.panel.remove();
    if (refocus) menu.button.focus({ preventScroll: true });
  }

  // 删除要确认：面板切换为 alertdialog，焦点默认落在"取消"上，回车不会误删。
  function renderConfirm() {
    const menu = state.menu;
    if (!menu) return;
    const title = element('div', 'aip-menu-confirm-title', TEXT.confirmTitle);
    title.id = 'aip-menu-confirm-title';
    const body = element('div', 'aip-menu-confirm-text', TEXT.confirmBody);
    body.id = 'aip-menu-confirm-desc';
    menu.panel.setAttribute('role', 'alertdialog');
    menu.panel.removeAttribute('aria-label');
    menu.panel.setAttribute('aria-labelledby', title.id);
    menu.panel.setAttribute('aria-describedby', body.id);

    const box = element('div', 'aip-menu-confirm');
    const actions = element('div', 'aip-menu-confirm-actions');
    const cancel = element('button', 'aip-menu-button', TEXT.confirmCancel);
    const remove = element('button', 'aip-menu-button aip-menu-button-danger', TEXT.confirmDelete);
    cancel.type = remove.type = 'button';
    cancel.dataset.action = 'cancel';
    remove.dataset.action = 'confirm';
    actions.append(cancel, remove);
    box.append(title, element('div', 'aip-menu-confirm-name', menu.title), body, actions);
    menu.panel.replaceChildren(box);
    positionMenu();
    cancel.focus({ preventScroll: true });
  }

  async function runMenuAction(action) {
    const menu = state.menu;
    if (!menu) return;
    const { id, row, title } = menu;
    closeMenu();                         // 焦点回到行尾的三点按钮
    if (action === 'rename') return ctx.edit.startEdit(row, true);
    if (action === 'share') return shareChat(row);
    if (action === 'select') return ctx.selection.enterSelection(id);
    if (action !== 'copy' && action !== 'delete') return;
    if (state.busy) return ctx.notice(TEXT.busy, 'error');
    state.busy = true;
    const outcome = action === 'copy'
      ? await requestAction(state, 'copy', { id, title: `${TEXT.copyPrefix}${title}` })
      : await requestAction(state, 'delete', { id });
    state.busy = false;
    if (!outcome.ok) return ctx.notice(failure(action, outcome.code), 'error');
    if (action === 'copy') return ctx.notice(TEXT.copied, 'ok');
    focusNeighbor(row);
    store.remove(id);
    ctx.notice(TEXT.deleted, 'ok');
    if (currentPromptId() === id) navigate('/library');     // 官方行为：删掉当前会话后回到 History 页
  }

  // 某一行要消失时，把键盘焦点挪到相邻的一行上。
  function focusNeighbor(row) {
    const rows = Array.from(state.scroll.querySelectorAll('.aip-row:not([hidden])'));
    const index = rows.indexOf(row);
    linkOf(rows[index + 1] || rows[index - 1])?.focus({ preventScroll: true });
  }

  // 复用 History 中目标会话的分享入口，打开 Google Drive 的共享对话框。
  async function shareChat(row) {
    const id = row.dataset.id;
    navigate('/library');
    const deadline = Date.now() + SHARE_WAIT_MS;
    while (Date.now() < deadline) {
      if (location.pathname !== '/library') break;
      const link = document.querySelector(`tr a[href="/prompts/${id}"]`);
      const more = link?.closest('tr')?.querySelector('button[aria-label="More options"]');
      if (more) {
        more.click();
        await delay(100);
        if (location.pathname !== '/library') break;
        const entry = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .find(node => node.textContent.trim().replace(/\s+/g, ' ').endsWith('Share') && node.getBoundingClientRect().width);
        if (entry && !entry.disabled && entry.getAttribute('aria-disabled') !== 'true') return entry.click();
        break;
      }
      await delay(200);
    }
    ctx.notice(TEXT.failed.share, 'error');
  }

  return { openMenu, closeMenu, positionMenu, renderConfirm, runMenuAction, focusNeighbor, shareChat };
};

/**
 * AI Studio Plus - Sidebar UI Coordinator
 * ISOLATED 世界。把时间分组的历史会话流嵌进原生导航 (ms-navbar-v2)，
 * 并协调内联重命名 (sidebar-edit)、多选批量删除 (sidebar-selection) 与三点菜单 (sidebar-menu)。
 * 所有节点都用 DOM API 构建，不用 innerHTML：站点启用了 Trusted Types，赋字符串会直接抛错。
 */
globalThis.AIPSidebarUI = (() => {
  const store = globalThis.AIPHistoryStore;
  const protocol = globalThis.AIPProtocol;
  const parts = globalThis.__AIPSidebarParts;
  const {
    NAV, LIST, PAGE_PACING_MS, PREFETCH_PX, SEARCH_DEBOUNCE_MS, NATIVE_ITEM, FOREIGN, TEXT,
    element, icon, rowOf, linkOf, checkboxOf, isComposing, place, exploreAnchor,
    captureAnchor, restoreAnchor, reveal, statusFor, navigate, currentPromptId, notice: showNotice
  } = parts.shared;

  const state = {
    nav: null, list: null, root: null, scroll: null, input: null, clear: null,
    selectStart: null, selectionBar: null, selectionCount: null, selectionDelete: null, selectionExit: null,
    notice: null, status: null, spinner: null, statusText: null, retry: null, handle: null, chevron: null,
    historyLink: null, open: false, rows: new Map(), groups: new Map(), marks: new WeakMap(), tick: 0,
    view: null, nearEnd: true, activeId: undefined, statusKind: '', revealed: false, edit: null, menu: null,
    busy: false, selecting: false, selected: new Set(), uncertain: new Set(), gesture: null,
    suppressClick: null, batchDialog: null, observer: null, io: null,
    frame: 0, searchTimer: 0, paceTimer: 0, noticeTimer: 0, actionSeq: 0, listening: false
  };

  const ctx = { state, store, syncRow, notice: (text, kind) => showNotice(state, text, kind) };
  Object.assign(ctx, { edit: parts.createEdit(ctx), selection: parts.createSelection(ctx), menu: parts.createMenu(ctx) });
  const { edit, selection, menu } = ctx;
  delete globalThis.__AIPSidebarParts;

  const on = (target, map, opts) => {
    for (const [type, fn] of Object.entries(map)) target.addEventListener(type, fn, opts);
  };
  const stopEvent = event => { event.preventDefault(); event.stopPropagation(); };

  // 1. 挂载与全局监听 ---------------------------------------------------------------------------

  function mount() {
    if (state.root && state.root.isConnected) return true;
    watch();
    const nav = document.querySelector(NAV), list = nav && nav.querySelector(LIST);
    if (!list) return false;
    const searchValue = state.input?.value || '';
    closePopups();
    selection.cancelPress();
    Object.assign(state, {
      nav, list, historyLink: null, rows: new Map(), groups: new Map(), marks: new WeakMap(),
      activeId: undefined, nearEnd: true, revealed: false, edit: null
    });
    styleNewChat(list);
    buildRoot();
    state.input.value = searchValue;
    buildHandle();
    const anchor = exploreAnchor(list);
    if (anchor) anchor.after(state.root); else list.prepend(state.root);
    tagDrawer(list);
    placeHandle(list);
    setDrawer(list, false);
    wire();
    if (!state.listening) {
      state.listening = true;
      store.subscribe(render);
      protocol.receive(protocol.ROUTE, onRoute);
      on(window, {
        popstate: onRoute, pointermove: selection.onPressMove,
        pointerup: selection.onPressEnd, pointercancel: selection.onPressEnd, blur: selection.cancelPress
      });
      on(window, { scroll: closePopups, resize: closePopups }, true);
      on(document, {
        pointerdown: event => { state.suppressClick = null; closePopupsOutside(event.target, true); },
        click: selection.suppressLongPressClick
      }, true);
      document.addEventListener('focusin', event => closePopupsOutside(event.target, false));
    } else render(store.getView());
    return true;
  }

  function watch() {
    if (state.observer) return;
    state.observer = new MutationObserver(records => {
      if (state.nav?.isConnected && state.root?.isConnected &&
          !records.some(r => state.nav.contains(r.target) || r.target.contains(state.nav))) return;
      if (!state.frame) state.frame = requestAnimationFrame(() => { state.frame = 0; ensure(); });
    });
    state.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function buildRoot() {
    const set = (k, tag, cls, text, attrs, kids) => (state[k] = element(tag, cls, text, attrs, kids));
    const btn = (k, cls, label, iconName, text, hidden) => set(
      k, 'button', cls, text ?? null,
      Object.assign({ type: 'button' }, label ? { 'aria-label': label } : null, hidden ? { hidden: true } : null),
      iconName ? [icon(iconName)] : null
    );
    const input = set('input', 'input', 'aip-search-input', null, { type: 'text', placeholder: TEXT.search, 'aria-label': TEXT.search, autocomplete: 'off', spellcheck: false });
    const status = set('status', 'div', 'aip-status', null, { 'aria-live': 'polite' }, [
      set('spinner', 'span', 'aip-spinner', null, { hidden: true, 'aria-hidden': 'true' }),
      set('statusText', 'span', 'aip-status-text'), btn('retry', 'aip-retry', null, null, TEXT.retry, true)
    ]);
    const scroll = set('scroll', 'div', 'aip-history-scroll', null, { tabIndex: 0, role: 'group', 'aria-label': TEXT.chatList }, [status]);
    const selectStart = btn('selectStart', 'aip-select-start', TEXT.selectChats, 'checklist');
    selectStart.title = TEXT.selectChats;
    set('root', 'div', 'aip-history', null, { id: 'aip-history', role: 'region', 'aria-label': TEXT.history }, [
      element('div', 'aip-search', null, null, [icon('search', 'aip-search-icon'), input, btn('clear', 'aip-search-clear', TEXT.clear, 'close', null, true)]),
      set('selectionBar', 'div', 'aip-selection-bar', null, { hidden: true }, [
        btn('selectionExit', 'aip-selection-exit', TEXT.exitSelection, 'close'),
        set('selectionCount', 'span', 'aip-selection-count', null, { 'aria-live': 'polite' }),
        btn('selectionDelete', 'aip-selection-delete', null, null, TEXT.confirmDelete)
      ]),
      element('div', 'aip-list-frame', null, null, [scroll, selectStart]),
      set('notice', 'div', 'aip-notice', null, { role: 'status', hidden: true })
    ]);
  }

  function buildHandle() {
    state.chevron = icon('expand_more', 'aip-drawer-chevron');
    state.handle = element('button', 'aip-drawer', null, { type: 'button', 'aria-expanded': 'false' }, [
      icon('apps', 'aip-drawer-icon'), element('span', 'aip-drawer-label', TEXT.drawer), state.chevron
    ]);
    state.handle.addEventListener('click', () => setDrawer(state.list, !state.open));
  }

  function wire() {
    const { scroll, input } = state;
    on(input, { input: onSearchInput, compositionend: applySearch });
    for (const [el, fn] of [
      [state.clear, () => { input.value = ''; applySearch(); input.focus(); }], [state.retry, () => store.retry()],
      [state.selectStart, () => selection.enterSelection()], [state.selectionExit, selection.exitSelection],
      [state.selectionDelete, selection.confirmBatchDelete]
    ]) el.addEventListener('click', fn);
    state.root.addEventListener('keydown', selection.onSelectionKeydown);
    on(scroll, {
      click: onRowClick, dblclick: onRowDoubleClick, contextmenu: onRowContextMenu,
      keydown: onListKeydown, focusout: edit.onEditBlur, pointerdown: selection.onPressStart, dragstart: selection.onPressScroll
    });
    scroll.addEventListener('scroll', selection.onPressScroll, { passive: true });
    if (typeof IntersectionObserver === 'function') {
      state.io?.disconnect();
      state.io = new IntersectionObserver(onSentinel, { root: scroll, rootMargin: `0px 0px ${PREFETCH_PX}px 0px` });
      state.io.observe(state.status);
    }
  }

  // 2. 原生入口与抽屉 ---------------------------------------------------------------------------

  function styleNewChat(scope) {
    for (const link of scope.querySelectorAll('a[href="/prompts/new_chat"]:not(.aip-new-chat)')) {
      link.classList.add('aip-new-chat');
      link.setAttribute('aria-label', TEXT.newChat);
      const label = link.querySelector('.nav-item-main-text');
      if (label) label.textContent = TEXT.newChat;
    }
    scope.querySelector('ms-nav-items-playground-v2 a[href="/library"]')?.classList.add('aip-native-history');
    const header = scope.querySelector('ms-nav-items-playground-v2')?.previousElementSibling;
    if (header?.classList.contains('section-header')) header.classList.add('aip-explore-heading');
  }

  function isNativeGroup(node) {
    if (node === state.handle || node.matches(FOREIGN) || node.querySelector(FOREIGN)) return false;
    if (node.classList.contains('section-header')) return true;
    const controls = Array.from(node.querySelectorAll('a[href], button'));
    if (node.matches('a[href], button')) controls.unshift(node);
    return controls.length > 0 && controls.every(control => control.classList.contains(NATIVE_ITEM));
  }

  function tagDrawer(list) {
    if (!list.querySelector(':scope > .aip-drawer-explore')) {
      const historyLink = element('a', 'aip-drawer-history', null, { href: '/library' }, [icon('history'), element('span', '', TEXT.drawerHistory)]);
      historyLink.addEventListener('click', event => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(historyLink.href);
      });
      state.historyLink = historyLink;
      state.root.after(element('div', 'aip-drawer-item aip-drawer-explore', null, null, [
        element('div', 'aip-drawer-explore-title', TEXT.drawerExplore), historyLink
      ]));
    } else state.historyLink = list.querySelector(':scope > .aip-drawer-explore > .aip-drawer-history');
    syncDrawerHistoryCurrent();
    for (let node = state.root.nextElementSibling; node; node = node.nextElementSibling) {
      if (node === state.handle || !isNativeGroup(node)) continue;
      node.classList.add('aip-drawer-item');
      if (node.classList.contains('section-header')) node.classList.add('aip-drawer-title');
    }
  }

  function syncDrawerHistoryCurrent() {
    if (!state.historyLink) return;
    if (location.pathname === '/library') state.historyLink.setAttribute('aria-current', 'page');
    else state.historyLink.removeAttribute('aria-current');
  }

  function placeHandle(list) {
    const items = list.querySelectorAll(':scope > .aip-drawer-item');
    const last = items.length ? items[items.length - 1] : state.root;
    if (last.nextSibling !== state.handle) list.insertBefore(state.handle, last.nextSibling);
  }

  function setDrawer(list, open) {
    state.open = open;
    list.classList.toggle('aip-drawer-open', open);
    state.handle.setAttribute('aria-expanded', String(open));
    state.chevron.textContent = open ? 'expand_more' : 'expand_less';
  }

  // 3. 列表渲染与增量对账 -----------------------------------------------------------------------

  function render(view) {
    state.view = view;
    if (!state.root || !state.root.isConnected) return;
    for (const id of state.selected) if (!view.ids.has(id)) { state.selected.delete(id); state.uncertain.delete(id); }
    const anchor = captureAnchor(state.scroll);
    reconcile(view);
    selection.renderSelection();
    restoreAnchor(state.scroll, anchor);
    renderStatus(view);
    if (state.clear.hidden === !!view.query) state.clear.hidden = !view.query;
    updateActive(true);
    maybeLoadMore();
  }

  function maybeLoadMore() {
    clearTimeout(state.paceTimer);
    if (!state.nearEnd || !state.view) return;
    const wait = PAGE_PACING_MS - (Date.now() - state.view.pageEventAt);
    if (wait > 0) state.paceTimer = setTimeout(maybeLoadMore, wait);
    else store.loadMore();
  }

  function reconcile(view) {
    const tick = ++state.tick;
    let previousGroup = null;
    for (const group of view.groups) {
      let groupEl = state.groups.get(group.key);
      if (!groupEl) {
        const titleId = `aip-group-${group.key}`;
        groupEl = element('div', 'aip-group', null, { role: 'group', 'aria-labelledby': titleId }, [
          element('div', 'aip-group-title', group.label, { id: titleId })
        ]);
        state.groups.set(group.key, groupEl);
      }
      state.marks.set(groupEl, tick);
      groupEl.hidden = false;
      place(state.scroll, groupEl, previousGroup);
      let previous = groupEl.firstChild;
      for (const item of group.items) {
        const row = state.rows.get(item.id) ? syncRow(state.rows.get(item.id), item) : buildRow(item);
        state.rows.set(item.id, row);
        state.marks.set(row, tick);
        if (row.hidden) row.hidden = false;
        place(groupEl, row, previous);
        previous = row;
      }
      previousGroup = groupEl;
    }
    for (const [id, row] of state.rows) {
      if (state.marks.get(row) === tick) continue;
      if (state.edit?.row === row) edit.cancelEdit();
      menu.closeMenu(row);
      if (view.ids.has(id)) row.hidden = true; else { row.remove(); state.rows.delete(id); }
    }
    for (const [key, groupEl] of state.groups) {
      if (state.marks.get(groupEl) !== tick) {
        if (groupEl.childNodes.length > 1) groupEl.hidden = true; else { groupEl.remove(); state.groups.delete(key); }
      }
    }
  }

  function buildRow(item) {
    const row = element('div', 'aip-row');
    row.dataset.id = item.id;
    const checkbox = element('input', 'aip-row-checkbox', null, { type: 'checkbox', tabIndex: -1 });
    checkbox.addEventListener('change', () => selection.setSelected(row.dataset.id, checkbox.checked));
    row.append(
      element('a', 'aip-row-link', null, { href: `/prompts/${item.id}` }, [element('span', 'aip-row-title')]), checkbox,
      element('button', 'aip-row-menu', null, { type: 'button', tabIndex: -1, 'aria-label': TEXT.more, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, [icon('more_vert', 'aip-row-menu-icon')])
    );
    return syncRow(row, item);
  }

  function syncRow(row, item) {
    const title = item.title || TEXT.untitled;
    row.title = title;
    const link = linkOf(row);
    if (link && link.title !== title) link.title = title;
    checkboxOf(row)?.setAttribute('aria-label', TEXT.selectRow(title));
    if (state.edit?.row === row) return row;
    const text = link?.firstElementChild;
    if (text && text.textContent !== title) text.textContent = title;
    return row;
  }

  function renderStatus(view) {
    const status = statusFor(view);
    state.spinner.hidden = !status.spinner;
    state.retry.hidden = !status.retry;
    if (state.statusText.textContent !== status.text) state.statusText.textContent = status.text;
    if (state.statusKind !== status.kind) { state.statusKind = status.kind; state.root.dataset.state = status.kind; }
  }

  function onSentinel(entries) { state.nearEnd = entries.some(entry => entry.isIntersecting); maybeLoadMore(); }

  // 4. 搜索、路由与交互分发 ---------------------------------------------------------------------

  function onSearchInput(event) {
    if (isComposing(event)) return;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
  }
  function applySearch() {
    clearTimeout(state.searchTimer);
    if (state.input.value) state.scroll.scrollTop = 0;
    store.setQuery(state.input.value);
  }

  function updateActive(force) {
    const id = currentPromptId();
    if (!force && id === state.activeId) return false;
    const before = state.rows.get(state.activeId), after = state.rows.get(id);
    if (before && before !== after) setActive(before, false);
    if (after) setActive(after, true);
    const navigated = state.activeId !== undefined && state.activeId !== id;
    state.activeId = id;
    store.noteCurrentPrompt(id);
    if (after && !after.hidden && (navigated || !state.revealed)) { state.revealed = true; reveal(state.scroll, after); }
    return navigated;
  }
  function setActive(row, active) {
    row.classList.toggle('is-active', active);
    const link = linkOf(row);
    if (link) active ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current');
  }

  function onRoute() {
    if (!state.root || !state.root.isConnected) return;
    closePopups();
    updateActive(false);
    syncDrawerHistoryCurrent();
  }

  function onRowClick(event) {
    const row = rowOf(event.target, '.aip-row');
    if (state.selecting && row) {
      if (event.target.matches('.aip-row-checkbox')) return;
      stopEvent(event);
      if (event.detail <= 1 && !state.busy) selection.setSelected(row.dataset.id, !state.selected.has(row.dataset.id));
      return;
    }
    const menuButton = rowOf(event.target, '.aip-row-menu');
    if (menuButton) { stopEvent(event); if (row) menu.openMenu(row, menuButton.getBoundingClientRect()); return; }
    const link = !event.button && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && rowOf(event.target, 'a.aip-row-link');
    if (link) { stopEvent(event); if (event.detail <= 1) navigate(link.href); }
  }

  function onRowDoubleClick(event) {
    if (state.selecting) return event.preventDefault();
    const row = rowOf(event.target, 'a.aip-row-link') && rowOf(event.target, '.aip-row');
    if (row) { stopEvent(event); edit.startEdit(row, true); }
  }
  function onRowContextMenu(event) {
    if (state.selecting || state.gesture?.activated) return event.preventDefault();
    const row = rowOf(event.target, '.aip-row');
    if (!row || state.edit?.row === row) return;
    stopEvent(event);
    const rect = row.getBoundingClientRect();
    const x = event.clientX || rect.right - 20, y = event.clientY || rect.top + rect.height / 2;
    menu.openMenu(row, { left: x, right: x, top: y, bottom: y });
  }
  function onListKeydown(event) {
    if ((state.edit && event.target === state.edit.input) || isComposing(event)) return;
    const row = rowOf(event.target, '.aip-row');
    if (state.selecting && row && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault();
      if (!state.busy) selection.setSelected(row.dataset.id, !state.selected.has(row.dataset.id));
    } else if (!state.selecting && row && event.key === 'F2') { event.preventDefault(); edit.startEdit(row, true); }
  }

  function closePopupsOutside(target, containsTrigger) {
    if (!(target instanceof Node)) return;
    const m = state.menu;
    if (m && !m.panel.contains(target) && !(containsTrigger ? m.button.contains(target) : target === m.button)) menu.closeMenu(undefined, false);
    const d = state.batchDialog;
    if (d && !d.contains(target) && !(containsTrigger ? state.selectionDelete?.contains(target) : target === state.selectionDelete)) selection.closeBatchDialog(false);
  }
  function closePopups() { menu.closeMenu(undefined, false); selection.closeBatchDialog(false); }

  function ensure() {
    if (!state.root || !state.root.isConnected) { if (mount()) onRoute(); return; }
    styleNewChat(state.list);
    tagDrawer(state.list);
    placeHandle(state.list);
  }

  return { mount };
})();

/**
 * AI Studio Plus - Sidebar Space (ISOLATED)
 * 窄屏覆盖模式交给 AI Studio 的原生按钮，统一管理左右侧栏预览的可用空间判断、时延与指针命中计算。
 */
globalThis.AIPSidebarSpace = (() => {
  const COMPACT_WIDTH = 640;
  const MIN_EDITOR_WIDTH = 400;
  const OPEN_DELAY = 300;
  const CLOSE_DELAY = 250;

  function containsPointer(rect, x, y) {
    return !!rect && rect.width > 0 && rect.height > 0 && Number.isFinite(x) && Number.isFinite(y) &&
      x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
  }

  function canPreview(side, panelWidth) {
    const pageWidth = document.documentElement.clientWidth;
    if (pageWidth <= COMPACT_WIDTH) return false;

    const left = document.querySelector('ms-navbar-v2 .nav-content');
    const right = document.querySelector('ms-right-side-panel');
    if ((left && !left.classList.contains('aip-peek') && getComputedStyle(left).position === 'fixed') ||
        (right && getComputedStyle(right).position === 'fixed')) return false;

    const oppositePeek = side === 'left' ? '.aip-run-peek' : '.nav-content.aip-peek';
    if (document.querySelector(oppositePeek)) return false;

    const editor = document.querySelector('.layout-main');
    const opposite = side === 'left' ? right : left;
    const remaining = pageWidth - (opposite?.getBoundingClientRect().width ?? 0);
    const available = Math.min(remaining, editor?.getBoundingClientRect().width ?? pageWidth);
    return available - panelWidth >= MIN_EDITOR_WIDTH;
  }

  return { OPEN_DELAY, CLOSE_DELAY, canPreview, containsPointer };
})();

/**
 * AI Studio Plus - Nav Collapse Peek (ISOLATED)
 * 原生导航折叠时提供临时悬浮预览；固定状态仍由 AI Studio 的按钮管理。
 */
globalThis.AIPNavCollapse = (() => {
  const protocol = globalThis.AIPProtocol;
  const space = globalThis.AIPSidebarSpace;
  const NAV = 'ms-navbar-v2';
  const CONTENT = '.nav-content';
  const OPEN = 'button[aria-label="Open navigation menu"]';
  const CLOSE = 'button[aria-label="Collapse navigation menu"]';
  const LOCKED = '.aip-history.is-selecting, .aip-row.is-editing, .aip-history.is-pressing, .aip-menu';
  let nav = null;
  let content = null;
  let pin = null;
  let peek = false;
  let restoreInert = false;
  let suppressed = false;
  let keyboardFocus = false;
  let timer = 0;
  let width = 240;
  let started = false;
  let syncQueued = false;
  let pointer = null;
  const contentObserver = new MutationObserver(() => sync());

  function isCollapsed() {
    return !!content && content.classList.contains('collapsed');
  }

  function locked() {
    return !!document.querySelector(LOCKED);
  }

  function stopTimer() {
    clearTimeout(timer);
    timer = 0;
  }

  // 折叠时宿主宽度接近零，预览和菜单可能位于其盒子之外：按可见区域判断指针位置。
  function containsPointer(node) {
    if (!pointer || !node) return false;
    return space.containsPointer(node.getBoundingClientRect(), pointer.x, pointer.y);
  }

  function insidePreview() {
    return containsPointer(document.querySelector(OPEN)) || containsPointer(content) || containsPointer(pin) ||
      containsPointer(document.querySelector('.aip-menu'));
  }

  function setPeek(open) {
    stopTimer();
    const next = open && isCollapsed();
    if (!content || next === peek) return;
    if (next) {
      nav.style.setProperty('--aip-collapsed-width', `${nav.getBoundingClientRect().width}px`);
      content.style.setProperty('--aip-peek-width', `${width}px`);
    }
    peek = next;
    content.classList.toggle('aip-peek', peek);
    if (peek) {
      enablePreviewInteraction();
      if (pin && pin.isConnected && !pin.matches(':popover-open')) {
        try { pin.showPopover(); } catch (_) {}
      }
    } else {
      if (restoreInert && isCollapsed()) content.inert = true;
      restoreInert = false;
      if (pin && pin.isConnected && pin.matches(':popover-open')) {
        try { pin.hidePopover(); } catch (_) {}
      }
      nav?.style.removeProperty('--aip-collapsed-width');
    }
  }

  // 原生折叠栏仍带 inert，即使 CSS 已经把预览画出来。
  function enablePreviewInteraction() {
    if (!content.inert) return;
    restoreInert = true;
    content.inert = false;
  }

  function laterClose() {
    stopTimer();
    if (!peek) return;
    timer = setTimeout(() => {
      timer = 0;
      const focused = document.activeElement;
      if (locked() || (keyboardFocus && (nav?.contains(focused) || focused === pin))) return;
      if (insidePreview()) return;
      setPeek(false);
    }, space.CLOSE_DELAY);
  }

  function scheduleOpen(trigger) {
    if (timer || !isCollapsed() || suppressed || peek || !space.canPreview('left', width)) return;
    timer = setTimeout(() => {
      timer = 0;
      if (!trigger.isConnected || suppressed || !space.canPreview('left', width)) return;
      if (containsPointer(trigger) || (keyboardFocus && trigger.contains(document.activeElement))) {
        setPeek(true);
      }
    }, space.OPEN_DELAY);
  }

  function sync() {
    const nextNav = document.querySelector(NAV);
    const nextContent = nextNav?.querySelector(CONTENT);
    if (!nextContent) {
      stopTimer();
      if (peek) setPeek(false);
      contentObserver.disconnect();
      pin?.remove();
      nav = null;
      content = null;
      pin = null;
      return;
    }
    if (nextContent !== content) {
      stopTimer();
      if (peek) setPeek(false);
      pin?.remove();
      nav = nextNav;
      content = nextContent;
      contentObserver.disconnect();
      contentObserver.observe(content, { attributes: true, attributeFilter: ['class', 'inert'] });
      pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'aip-peek-pin ms-button-borderless ms-button-icon';
      pin.setAttribute('ms-button', '');
      pin.setAttribute('variant', 'icon-borderless');
      pin.setAttribute('popover', 'manual');
      pin.setAttribute('aria-label', 'Pin navigation');
      pin.title = 'Pin navigation';
      const symbol = document.createElement('span');
      symbol.className = 'material-symbols-outlined notranslate ms-button-icon-symbol';
      symbol.setAttribute('aria-hidden', 'true');
      symbol.textContent = 'keep';
      pin.appendChild(symbol);
      pin.addEventListener('click', () => {
        if (!peek) return;
        stopTimer();
        document.querySelector(OPEN)?.click();
      });
      document.body.appendChild(pin);
    }
    if (!isCollapsed()) {
      const measured = content.getBoundingClientRect().width;
      if (measured > 100) width = measured;
      if (peek) setPeek(false);
    } else if (peek) {
      enablePreviewInteraction();
    }
  }

  function scheduleSync() {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      sync();
    });
  }

  function onPointerOver(event) {
    if (event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY };
    const target = event.target instanceof Element ? event.target : null;
    if (peek) {
      if (insidePreview()) stopTimer();
      return;
    }
    const trigger = document.querySelector(OPEN);
    if (!target || !trigger?.contains(target)) return;
    if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
    scheduleOpen(trigger);
  }

  function onPointerOut(event) {
    if (event.pointerType === 'touch') return;
    const leftWindow = !event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0 ||
      event.clientX >= window.innerWidth || event.clientY >= window.innerHeight);
    pointer = leftWindow ? null : { x: event.clientX, y: event.clientY };
    const target = event.target instanceof Element ? event.target : null;
    const trigger = document.querySelector(OPEN);
    if (!peek) {
      if (target && trigger?.contains(target) &&
          !(event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) &&
          !(keyboardFocus && trigger.contains(document.activeElement))) stopTimer();
      return;
    }
    if (insidePreview()) stopTimer();
    else if (!timer) laterClose();
  }

  function editable(event) {
    return event.composedPath().some(node => node instanceof HTMLElement &&
      (node.isContentEditable || node.matches('input, textarea, select, [role="textbox"], [role="combobox"], [role="searchbox"], .monaco-editor, .cm-editor')));
  }

  function isComposing(event) {
    return protocol ? protocol.isImeComposing(event) : !!(event && (event.isComposing || event.keyCode === 229));
  }

  function onKey(event) {
    keyboardFocus = true;
    if (!event.isTrusted || event.defaultPrevented || event.repeat || isComposing(event)) return;
    if (event.key === 'Escape' && peek && !locked()) {
      suppressed = true;
      setPeek(false);
      document.querySelector(OPEN)?.focus({ preventScroll: true });
      return;
    }
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    if (event.key.toLowerCase() !== 'b' || event.altKey || event.shiftKey ||
        (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) || editable(event) || locked()) return;
    const button = document.querySelector(isCollapsed() ? OPEN : CLOSE);
    if (!button) return;
    event.preventDefault();
    if (!isCollapsed()) suppressed = true;
    button.click();
  }

  function start() {
    if (started) return;
    started = true;
    sync();
    const observer = new MutationObserver(() => {
      if (!content?.isConnected || !pin?.isConnected) {
        if (!nav) scheduleSync();
        else sync();
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('pointerdown', event => {
      keyboardFocus = false;
      if (event.target instanceof Element && event.target.closest(OPEN)) stopTimer();
    }, true);
    document.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch') return;
      pointer = { x: event.clientX, y: event.clientY };
      if (suppressed && !containsPointer(document.querySelector(OPEN))) suppressed = false;
      if (!peek) return;
      if (event.buttons !== 0) {
        stopTimer();
        return;
      }
      if (insidePreview()) stopTimer();
      else if (!timer) laterClose();
    });
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(OPEN)) stopTimer();
      if (event.target.closest(CLOSE) && !peek) suppressed = true;
      if (peek) setTimeout(laterClose, 0);
    }, true);
    document.addEventListener('focusin', event => {
      if (!keyboardFocus || !(event.target instanceof Element)) return;
      const trigger = event.target.closest(OPEN);
      if (trigger) scheduleOpen(trigger);
    });
    document.addEventListener('focusout', () => { if (peek) setTimeout(laterClose, 0); });
    window.addEventListener('scroll', () => { if (peek && !insidePreview()) laterClose(); }, true);
    window.addEventListener('resize', () => {
      if ((!timer && !peek) || space.canPreview('left', width)) return;
      if (!peek) stopTimer();
      else if (!locked() && !nav?.contains(document.activeElement) && document.activeElement !== pin) setPeek(false);
    });
    document.addEventListener('keydown', onKey);
  }

  return { start };
})();

/**
 * AI Studio Plus - Run Settings Peek (ISOLATED)
 * Run settings 在悬浮时临时展开，固定状态交给站点原生控件管理。
 */
globalThis.AIPRunSettingsPeek = (() => {
  const space = globalThis.AIPSidebarSpace;
  const HOST = 'ms-right-side-panel';
  const PANEL = 'ms-run-settings';
  const OPEN = 'button.runsettings-toggle-button[aria-label="Toggle run settings panel"]';
  const CLOSE = 'button[aria-label="Close run settings panel"]';
  const PREVIEW_WIDTH = 300;
  let preview = false;
  let closing = false;
  let suppressed = false;
  let timer = 0;
  let pointer = null;
  let pin = null;
  let panelMounted = false;
  let started = false;
  let syncQueued = false;

  function stop() { clearTimeout(timer); timer = 0; }
  function within(node) {
    if (!pointer || !node) return false;
    return space.containsPointer(node.getBoundingClientRect(), pointer.x, pointer.y);
  }
  function inside() {
    const panel = document.querySelector(PANEL);
    const controls = panel && Array.from(panel.querySelectorAll('[aria-controls], [aria-owns]'));
    return within(panel) || within(document.querySelector(OPEN)) || (controls || []).some(control => {
      const ids = `${control.getAttribute('aria-controls') || ''} ${control.getAttribute('aria-owns') || ''}`.trim().split(/\s+/);
      return ids.some(id => id && within(document.getElementById(id)));
    });
  }
  function locked() {
    const panel = document.querySelector(PANEL);
    if (!panel) return false;
    if (panel.contains(document.activeElement) && document.activeElement.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return true;
    return Array.from(panel.querySelectorAll('[aria-expanded="true"][aria-controls], [aria-expanded="true"][aria-owns]')).some(node => node.isConnected);
  }
  function cleanup() {
    preview = false;
    closing = false;
    panelMounted = false;
    document.querySelector(HOST)?.classList.remove('aip-run-peek');
    pin?.remove();
    pin = null;
  }
  function closePreview() {
    if (!preview || closing) return;
    const close = document.querySelector(`${PANEL} ${CLOSE}`);
    if (!close) { cleanup(); return; }
    closing = true;
    close.click();
  }
  function laterClose() {
    stop();
    if (!preview) return;
    timer = setTimeout(() => { timer = 0; if (!inside() && !locked()) closePreview(); }, space.CLOSE_DELAY);
  }
  function sync() {
    if (!preview) return;
    const host = document.querySelector(HOST);
    const panel = host?.querySelector(PANEL);
    if (!host || !panel) {
      if (panelMounted) cleanup();
      return;
    }
    panelMounted = true;
    host.classList.add('aip-run-peek');
    const close = panel.querySelector(CLOSE);
    if (!close || pin?.isConnected) return;
    pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'aip-run-pin';
    pin.setAttribute('aria-label', 'Pin run settings');
    pin.title = 'Pin run settings';
    const symbol = document.createElement('span');
    symbol.className = 'material-symbols-outlined notranslate';
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = 'keep';
    pin.appendChild(symbol);
    pin.addEventListener('click', () => { stop(); cleanup(); });
    close.before(pin);
  }
  function scheduleSync() {
    if (!preview || syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      sync();
    });
  }
  function start() {
    if (started) return;
    started = true;
    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch') return;
      pointer = { x: event.clientX, y: event.clientY };
      if (preview) { if (inside()) stop(); return; }
      const trigger = document.querySelector(OPEN);
      if (!timer && !suppressed && trigger?.contains(event.target) && !document.querySelector(PANEL) &&
          space.canPreview('right', PREVIEW_WIDTH)) {
        timer = setTimeout(() => {
          timer = 0;
          const host = document.querySelector(HOST);
          if (!host || !trigger.isConnected || !within(trigger) || document.querySelector(PANEL) ||
              !space.canPreview('right', PREVIEW_WIDTH)) return;
          preview = true;
          host.classList.add('aip-run-peek');
          trigger.click();
          sync();
        }, space.OPEN_DELAY);
      }
    });
    document.addEventListener('pointermove', event => {
      if (event.pointerType === 'touch') return;
      pointer = { x: event.clientX, y: event.clientY };
      if (suppressed && !within(document.querySelector(OPEN))) suppressed = false;
      if (!preview) return;
      if (event.buttons !== 0) { stop(); return; }
      if (inside()) stop();
      else if (!timer) laterClose();
    });
    document.addEventListener('pointerout', event => {
      if (event.pointerType === 'touch') return;
      const leftWindow = !event.relatedTarget && (event.clientX <= 0 || event.clientY <= 0 ||
        event.clientX >= window.innerWidth || event.clientY >= window.innerHeight);
      pointer = leftWindow ? null : { x: event.clientX, y: event.clientY };
      if (preview) { if (inside()) stop(); else if (!timer) laterClose(); }
      else if (!within(document.querySelector(OPEN))) stop();
    });
    document.addEventListener('pointerdown', event => {
      if (preview || !(event.target instanceof Element) || !event.target.closest(OPEN)) return;
      stop();
    }, true);
    document.addEventListener('click', event => {
      if (!preview && event.target instanceof Element && event.target.closest(OPEN)) stop();
    }, true);
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(`${PANEL} ${CLOSE}`) && !closing) { if (event.isTrusted) suppressed = true; stop(); cleanup(); }
      if (preview) setTimeout(laterClose, 0);
    });
    document.addEventListener('focusout', () => { if (preview) setTimeout(laterClose, 0); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && preview && !locked()) { suppressed = true; closePreview(); }
    });
    window.addEventListener('resize', () => {
      if ((!timer && !preview) || space.canPreview('right', PREVIEW_WIDTH) || locked()) return;
      stop();
      closePreview();
    });
  }
  return { start };
})();

/**
 * AI Studio Plus - Bubbles Module
 * 负责用户消息右对齐深色气泡绘制、长消息自动折叠 (>300px 折叠为 240px 预览)、
 * 视口高度占位感知 (防空黑块) 与 Anti-Layout Thrashing 缓存机制。
 */
globalThis.AIPBubbles = (() => {
  const COLLAPSE_THRESHOLD_PX = 300;
  const SCROLL_DELAY_MS = 100;
  const selector = 'ms-chat-turn > .chat-turn-container.user';
  const states = new WeakMap();
  let queued = false;

  function refresh() {
    queued = false;
    const containers = document.querySelectorAll(selector);
    if (!containers.length) return;

    containers.forEach(container => {
      const prompt = container.querySelector('.user-prompt-container');
      if (!prompt) return;
      let state = states.get(container);
      if (!state) {
        container.querySelectorAll(':scope > .aib-toggle').forEach(button => button.remove());
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'aib-toggle';
        state = { button, expanded: false, prompt: null, measuredHeight: 0, dirty: true };
        states.set(container, state);
        button.addEventListener('click', () => {
          state.expanded = !state.expanded;
          refresh();
          // 等待 AI Studio 内部更新其缓存的 turn 高度后再进行平滑定位
          if (!state.expanded) setTimeout(() => {
            if (container.isConnected) container.scrollIntoView({ block: 'start' });
          }, SCROLL_DELAY_MS);
        });
      }
      if (state.prompt !== prompt) {
        if (state.prompt) resize.unobserve(state.prompt);
        state.prompt = prompt;
        state.dirty = true;
        resize.observe(prompt);
      }
      const content = prompt.querySelector('.turn-content');
      const ready = !!content && (content.textContent.trim().length > 0 ||
        !!content.querySelector('img, video, canvas, audio, textarea, [contenteditable="true"]'));
      container.toggleAttribute('data-aib-ready', ready);
      const placeholder = prompt.firstElementChild;

      // 读取内联样式高度 (不触发重排)
      const placeholderHeight = parseFloat(placeholder?.style.height) || 0;
      let height = placeholderHeight;
      if (height <= COLLAPSE_THRESHOLD_PX && (state.dirty || !state.measuredHeight)) {
        state.measuredHeight = content?.scrollHeight || 0;
        state.dirty = false;
      }
      height = Math.max(height, state.measuredHeight);

      const editing = container.querySelector('textarea, [contenteditable="true"]') ||
        !container.classList.contains('render');
      const long = ready && height > COLLAPSE_THRESHOLD_PX;
      const collapsed = long && !state.expanded && !editing;
      container.toggleAttribute('data-aib-collapsed', collapsed);
      state.button.hidden = !long || !!editing;
      state.button.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? '显示更多' : '收起';
      if (state.button.textContent !== label) state.button.textContent = label;
      if (state.button.parentElement !== container) container.append(state.button);
    });
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(refresh);
  }

  const resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      const container = entry.target.closest(selector);
      const state = container && states.get(container);
      if (state) {
        state.dirty = true;
        if (!container.hasAttribute('data-aib-collapsed')) {
          state.measuredHeight = entry.contentRect.height;
        }
      }
    }
    schedule();
  });

  const observer = new MutationObserver(records => {
    let shouldSchedule = false;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('.aib-toggle')) continue;
      const userContainer = target?.closest(selector);
      if (userContainer) {
        const state = states.get(userContainer);
        if (state) state.dirty = true;
        const hasRelevantAdd = Array.from(record.addedNodes).some(n => !n.classList?.contains('aib-toggle'));
        if (hasRelevantAdd || record.type !== 'childList' || record.removedNodes.length > 0) {
          shouldSchedule = true;
          break;
        }
      } else {
        const hasTurn = Array.from(record.addedNodes).some(n => n.nodeType === 1 &&
          (n.matches(selector) || n.querySelector(selector)));
        if (hasTurn) {
          shouldSchedule = true;
          break;
        }
      }
    }
    if (shouldSchedule) schedule();
  });

  function init() {
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'contenteditable']
    });
    refresh();
  }

  return { init, refresh, schedule };
})();

/**
 * AI Studio Plus - Main Orchestrator
 * ISOLATED 世界的入口 (document_start)：等 DOM 可用后启动气泡与侧栏；
 * 浏览器不支持 content_scripts.world = "MAIN" 时，负责把拦截器兜底注入主世界。
 */
(() => {
  const MARKER = 'data-aip-interceptor';

  // 1. 气泡与侧栏都要等 <body> 出来
  function start() {
    globalThis.AIPBubbles?.init();
    globalThis.AIPSidebarUI?.mount();
    globalThis.AIPNavCollapse?.start();
    globalThis.AIPRunSettingsPeek?.start();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  // 2. 拦截器若已由 manifest 以 MAIN 世界注入，会在 document_start 第一时间在 <html> 上留标记；
  //    DOM 就绪时还没有标记，说明浏览器不认 world: "MAIN"，改用 <script src> 注入。
  function ensureInterceptor() {
    if (document.documentElement.hasAttribute(MARKER)) return;
    let url = '';
    try {
      url = chrome.runtime.getURL('interceptor.js');
    } catch (_) {
      return;
    }
    const script = document.createElement('script');
    script.src = url; // aip-lint-allow: trusted-script-fallback
    script.async = false;
    script.addEventListener('load', () => {
      script.remove();
      globalThis.AIPHistoryStore?.hello();     // 这时主世界已经在听了：告诉它这边已就绪
    });
    script.addEventListener('error', () => script.remove());
    (document.head || document.documentElement).appendChild(script);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureInterceptor, { once: true });
  else ensureInterceptor();
})();
