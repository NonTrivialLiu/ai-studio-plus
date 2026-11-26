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
