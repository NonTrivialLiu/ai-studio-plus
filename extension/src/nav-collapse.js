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
  let hostObserver = null;
  let ancestorObserver = null;
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
      syncWatchScope();
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
      syncWatchScope();
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

  // 挂载完成后仅监听 nav 自身及祖先链直系子节点，屏蔽对话区虚拟滚动带来的全树抖动
  function syncWatchScope() {
    if (!hostObserver || !ancestorObserver) return;
    hostObserver.disconnect();
    ancestorObserver.disconnect();
    if (nav?.isConnected && content?.isConnected) {
      hostObserver.observe(nav, { childList: true, subtree: false });
      const watched = new Set();
      for (let el = nav.parentElement; el && el !== document.documentElement; el = el.parentElement) {
        if (!watched.has(el)) { watched.add(el); ancestorObserver.observe(el, { childList: true, subtree: false }); }
      }
      if (pin?.parentElement && !watched.has(pin.parentElement)) {
        ancestorObserver.observe(pin.parentElement, { childList: true, subtree: false });
      }
      return;
    }
    const fallback = document.body || document.documentElement;
    if (fallback) hostObserver.observe(fallback, { subtree: true, childList: true });
  }

  function start() {
    if (started) return;
    started = true;
    const onWatch = () => {
      if (!content?.isConnected || !pin?.isConnected) {
        if (!nav) scheduleSync();
        else sync();
      }
    };
    hostObserver = new MutationObserver(onWatch);
    ancestorObserver = new MutationObserver(onWatch);
    sync();
    syncWatchScope();
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
