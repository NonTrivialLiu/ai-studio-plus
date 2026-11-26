/*
 * 仿真站点里的"宿主应用"：像 AI Studio 一样用 XHR 请求 ListPrompts (跨域、带 Cookie 与鉴权头)，
 * 用 history.pushState 做站内路由。它在页面的主世界里运行，是扩展拦截器的"对手方"。
 */
(() => {
  const API = document.body.dataset.api;
  // 与线上一致：服务名前是句点。
  const RPC = `${API}/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService`;
  const view = document.getElementById('view');
  let nonce = 0;

  function rpc(name, body, onDone) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${RPC}/${name}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json+protobuf');
    xhr.setRequestHeader('Authorization', 'SAPISIDHASH 1_test');
    xhr.setRequestHeader('X-Goog-Api-Key', 'test-key');
    xhr.setRequestHeader('X-App-Nonce', `app-${++nonce}`);   // 每次请求都是新值：服务器据此分辨页面请求与扩展代发
    xhr.onloadend = () => onDone && onDone(xhr.status, xhr.responseText);
    xhr.send(body);
    return xhr;
  }

  function render(text) {
    const record = JSON.parse(text)[0][0];
    view.textContent = `${location.pathname} | 首条：${record ? record[0] : '无'}`;
  }

  // History 页会把所有分页连续取完。
  function listAll() {
    const step = token => rpc('ListPrompts', JSON.stringify(token ? [100, token] : [100]), (status, text) => {
      if (status !== 200) return;
      render(text);
      const next = JSON.parse(text)[1];
      if (next) step(next);
    });
    step(null);
  }

  function route() {
    if (location.pathname === '/library') listAll();
    else rpc('ListPrompts', '[100]', () => {});
    // 线上页面启动后还会陆续发一些别的接口请求 (如 GetUserPreferences)。
    setTimeout(() => rpc('GetUserPreferences', '[]', () => {}), 800);
  }

  // 模拟 Angular 的 RouterLink：原生导航链接点击后走站内路由。
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || link.closest('.aip-history, .aip-menu')) return;   // 侧栏与它的菜单自己处理
    event.preventDefault();
    history.pushState({}, '', link.getAttribute('href'));
    route();
  });
  window.addEventListener('popstate', route);

  async function boot() {
    await fetch(`${API}/session`, { credentials: 'include' });   // 登录态：拿 Cookie
    const slow = Number(new URLSearchParams(location.search).get('slow') || 0);
    setTimeout(route, slow);
  }

  window.__app = { rpc, route };
  boot();
})();
