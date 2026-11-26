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
