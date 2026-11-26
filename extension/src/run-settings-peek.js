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
