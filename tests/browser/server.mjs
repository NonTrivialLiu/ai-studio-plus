/**
 * 本地的 AI Studio 仿真站点：页面与接口分别跑在 127.0.0.1 的两个端口上
 * (同站但跨域，所以 Cookie 照常携带，同时又要过 CORS——与线上一致)。
 * 接口按 2026-11 实测的 jspb 数组编码返回数据，并校验 Cookie 与鉴权头。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 100;

const AUTHOR = ['Tester', 1, 'https://example.invalid/avatar.png'];
const record = ({ id, title, seconds }) => [
  `prompts/${id}`, null, null, null,
  [title, null, AUTHOR, null, [[String(seconds), 0], AUTHOR], [1, 1, 1], null, null, null, null, [],
    [['hasImages', 'false'], ['promptType', 'PROMPT_TYPE_CHAT'], ['version', '1']]],
  null, null, null, null, null, null, null, null, []
];

function listen(handler) {
  const server = createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function readBody(request) {
  return new Promise(resolve => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => resolve(body));
  });
}

/**
 * 启动仿真站点。total 是会话总数；每条会话的更新时间依次相隔 6 小时，
 * 于是今天 / 昨天 / 最近 7 天 / 最近 30 天 / 更早各分组都有数据。
 */
export async function startFixture({ total = 350 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const prompts = [];
  let created = 0;
  const log = [];
  const nonceSeen = new Set();
  const failures = new Map();        // 接口名 → 下一次调用返回的状态码 (模拟失败)

  // 序号为偶数的会话标题是英文 ("Session NNNN about RL tuning")，奇数是中文。
  function reset() {
    prompts.length = 0;
    for (let i = 0; i < total; i++) {
      const number = String(i + 1).padStart(4, '0');
      const title = i % 2 ? `Session ${number} about RL tuning` : `会话 ${number}：电网拓扑优化`;
      prompts.push({ id: `p${number}`, title, seconds: now - i * 6 * 3600 });
    }
    created = 0;
    log.length = 0;
    nonceSeen.clear();
    failures.clear();
  }
  reset();

  const page = await listen(async (request, response) => {
    const url = new URL(request.url, 'http://placeholder');
    const send = (type, body) => {
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      response.end(body);
    };
    if (url.pathname === '/app.css') return send('text/css', readFileSync(join(HERE, 'fixture', 'app.css')));
    if (url.pathname === '/app.js') return send('text/javascript', readFileSync(join(HERE, 'fixture', 'app.js')));
    if (url.pathname === '/settings') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "require-trusted-types-for 'script'",
        'Cache-Control': 'no-store'
      });
      return response.end('<!doctype html><meta charset="utf-8"><title>Settings</title><main>Settings</main>');
    }
    if (url.pathname !== '/' && !url.pathname.startsWith('/library') && !url.pathname.startsWith('/prompts')) {
      response.writeHead(404);
      return response.end();
    }
    // 与线上一样启用 Trusted Types：扩展的主世界脚本若用 innerHTML 会直接抛错。
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
      'Cache-Control': 'no-store'
    });
    // 页面服务器要先于接口服务器启动，接口地址在服务器启动后再回填。
    response.end(pageHtml.replace('__API__', api.origin));
  });

  const api = await listen(async (request, response) => {
    const cors = {
      'Access-Control-Allow-Origin': page.origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Goog-Api-Key, X-User-Agent, X-App-Nonce',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      return response.end();
    }
    if (request.url === '/session') {
      response.writeHead(200, { ...cors, 'Content-Type': 'text/plain', 'Set-Cookie': 'SID=ok; Path=/; SameSite=Lax' });
      return response.end('ok');
    }
    const name = /MakerSuiteService\/([A-Za-z]+)$/.exec(request.url)?.[1];
    if (!name) {
      response.writeHead(404, cors);
      return response.end();
    }
    const cookie = /(?:^|;\s*)SID=ok/.test(request.headers.cookie || '');
    const authorization = request.headers.authorization || '';
    const nonce = request.headers['x-app-nonce'] || '';
    // 页面每个请求带一个新的 nonce；扩展代发时沿用页面首批请求头里的旧值。
    const fromExtension = nonceSeen.has(nonce);
    if (nonce) nonceSeen.add(nonce);
    const entry = { name, cookie, authorization, fromExtension, body: null, status: 0 };
    log.push(entry);

    const reply = (status, text) => {
      entry.status = status;
      response.writeHead(status, { ...cors, 'Connection': 'close', 'Content-Type': 'application/json+protobuf; charset=UTF-8' });
      response.end(text);
    };
    if (!cookie || !authorization) return reply(401, JSON.stringify([16, 'Request is missing required authentication credential.']));
    const body = JSON.parse((await readBody(request)) || 'null');
    entry.body = body;
    if (failures.has(name)) {
      const failure = failures.get(name);
      failures.delete(name);
      if (failure === 'network') return request.socket.destroy();
      return reply(failure, JSON.stringify([13, 'simulated failure']));
    }
    if (name === 'ListPrompts') {
      const offset = body && typeof body[1] === 'string' ? Number(body[1].slice(1)) : 0;
      const size = body && Number(body[0]) > 0 ? Number(body[0]) : 100;
      const slice = prompts.slice(offset, offset + size);
      return reply(200, JSON.stringify([slice.map(record), offset + size < prompts.length ? `t${offset + size}` : undefined].filter(part => part !== undefined)));
    }
    // ---- 改名 / 复制：与官方客户端同一套调用 (先取完整会话，再整体提交) --------------------------------
    const findPrompt = key => prompts.find(prompt => `prompts/${prompt.id}` === String(key));
    if (name === 'ResolveDriveResource' && body && typeof body[0] === 'string') {
      const full = findPrompt(body[0]) || prompts.find(prompt => prompt.id === body[0]);
      const data = full ? record(full) : null;
      if (data) data[3] = [['gemini-fixture'], [1, 1, 1]];     // 模型配置：只有完整记录才有
      return reply(200, JSON.stringify([data]));
    }
    if (name === 'UpdatePrompt' && body && Array.isArray(body[0])) {
      const target = findPrompt(body[0][0]);
      if (target) target.title = String(body[0][4] && body[0][4][0]);
    }
    if (name === 'CreatePrompt' && body && body.length) {
      // 页面新建时传标题；扩展复制时传整条会话记录 (标题在第 5 个字段)。
      const source = body[0];
      const title = Array.isArray(source) ? String(source[4] && source[4][0]) : String(source);
      prompts.unshift({ id: `created-${++created}`, title, seconds: Math.floor(Date.now() / 1000) });
    }
    if (name === 'DeletePrompt' && body && body.length) {
      const target = typeof body === 'string' ? body : body && body[0];
      const index = prompts.findIndex(prompt => `prompts/${prompt.id}` === String(target));
      if (index >= 0) prompts.splice(index, 1);
    }
    return reply(200, '[]');
  });

  const navbar = readFileSync(join(HERE, '..', 'fixtures', 'navbar.html'), 'utf8');
  const pageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>AI Studio fixture</title>
<link rel="stylesheet" href="/app.css">
</head>
<body data-api="__API__" class="light-theme">
<ms-app>
${navbar}
<main id="view">loading</main>
</ms-app>
<script src="/app.js"></script>
</body>
</html>
`;

  return {
    pageOrigin: page.origin,
    apiOrigin: api.origin,
    log,
    reset,
    fail(name, status = 500) { failures.set(name, status); },
    get prompts() { return prompts; },
    async close() {
      await Promise.all([page, api].map(({ server }) => new Promise(resolve => server.close(resolve))));
    }
  };
}
