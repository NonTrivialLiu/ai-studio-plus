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
