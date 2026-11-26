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
