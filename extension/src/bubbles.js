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
