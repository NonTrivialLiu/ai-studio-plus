/**
 * AI Studio Plus - Bubbles Module
 * 负责用户消息右对齐深色气泡绘制、长消息自动折叠 (>300px 折叠为 240px 预览)、
 * 视口高度占位感知 (防空黑块) 与 Anti-Layout Thrashing 缓存机制。
 * 增量脏集刷新 + 被动滚动让路 + 双层收窄观测器，避免超长对话高速滚动或流式吐字抢占主线程。
 */
globalThis.AIPBubbles = (() => {
  const COLLAPSE_THRESHOLD_PX = 300;
  const SCROLL_DELAY_MS = 100;
  const SCROLL_IDLE_MS = 120;
  const selector = 'ms-chat-turn > .chat-turn-container.user';
  const TURN_OBSERVE_OPTIONS = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'contenteditable']
  };
  const states = new WeakMap();
  const observedTurns = new WeakSet();
  const dirtyTurns = new Set();
  let fullScan = false;
  let queued = false;
  let scrolling = false;
  let scrollIdleTimer = 0;
  let initialized = false;

  function observeTurn(container) {
    if (observedTurns.has(container)) return;
    observedTurns.add(container);
    turnObserver.observe(container, TURN_OBSERVE_OPTIONS);
  }

  function processContainer(container) {
    if (!container || container.isConnected === false) return;
    observeTurn(container);
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
        processContainer(container);
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
  }

  function refresh() {
    queued = false;
    fullScan = false;
    dirtyTurns.clear();
    const containers = document.querySelectorAll(selector);
    if (!containers.length) return;
    containers.forEach(processContainer);
  }

  function flush() {
    queued = false;
    if (scrolling) return;
    if (fullScan) {
      refresh();
      return;
    }
    if (!dirtyTurns.size) return;
    const batch = Array.from(dirtyTurns);
    dirtyTurns.clear();
    for (const container of batch) processContainer(container);
  }

  function queueFlush() {
    if (scrolling || queued || (!fullScan && !dirtyTurns.size)) return;
    queued = true;
    requestAnimationFrame(flush);
  }

  function schedule(container) {
    if (container) dirtyTurns.add(container);
    else fullScan = true;
    queueFlush();
  }

  function onScroll(event) {
    const target = event?.target;
    if (target?.closest?.('#aip-history')) return;
    scrolling = true;
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      scrolling = false;
      queueFlush();
    }, SCROLL_IDLE_MS);
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
      if (container) schedule(container);
    }
  });

  const turnObserver = new MutationObserver(records => {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('.aib-toggle')) continue;
      const userContainer = target?.closest(selector);
      if (!userContainer) continue;
      const state = states.get(userContainer);
      if (state) state.dirty = true;
      const hasRelevantAdd = Array.from(record.addedNodes).some(n => !n.classList?.contains('aib-toggle'));
      if (hasRelevantAdd || record.type !== 'childList' || record.removedNodes.length > 0) {
        schedule(userContainer);
      }
    }
  });

  const rootObserver = new MutationObserver(records => {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const target = record.target;
      if (target.nodeType === 1 && target.closest('.chat-turn-container.model')) continue;
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(selector)) schedule(node);
        else node.querySelectorAll(selector).forEach(schedule);
      }
    }
  });

  function init() {
    if (!initialized) {
      initialized = true;
      rootObserver.observe(document.body, { subtree: true, childList: true });
      document.addEventListener?.('scroll', onScroll, { passive: true, capture: true });
    }
    refresh();
  }

  return { init, refresh, schedule };
})();
