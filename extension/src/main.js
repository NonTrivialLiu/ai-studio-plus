/**
 * AI Studio Plus - Main Orchestrator
 * ISOLATED 世界的入口 (document_start)：在文档起点预热关键跨域连接、等 DOM 可用后启动气泡与侧栏；
 * 浏览器不支持 content_scripts.world = "MAIN" 时，负责把拦截器兜底注入主世界。
 */
(() => {
  const MARKER = 'data-aip-interceptor';
  const PRECONNECT_ORIGINS = [
    'https://waa-pa.clients6.google.com',
    'https://apis.google.com',
    'https://people-pa.clients6.google.com'
  ];

  // 在 document_start 并行预热页面缺失的关键跨域 TLS/代理隧道，标准 Hint 失败安全退化
  function injectPreconnects() {
    const parent = document.head || document.documentElement;
    if (!parent) return;
    const existing = new Set();
    document.querySelectorAll('link[rel~="preconnect"][href]').forEach(el => {
      try { existing.add(new URL(el.href, location.href).origin); } catch (_) {}
    });
    for (const origin of PRECONNECT_ORIGINS) {
      if (existing.has(origin)) continue;
      existing.add(origin);
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      link.crossOrigin = 'anonymous';
      link.dataset.aipPreconnect = '1';
      parent.appendChild(link);
    }
  }
  injectPreconnects();

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
