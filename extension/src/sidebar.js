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
