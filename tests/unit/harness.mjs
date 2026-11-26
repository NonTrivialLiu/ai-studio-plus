/**
 * 单元测试底座：在 Node 的 vm 沙箱里造一个够用的"窗口"，让浏览器脚本原样跑起来。
 * 被测脚本的 Date / setTimeout 走可控时钟，postMessage 走真实浏览器那样的异步投递。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const flush = () => new Promise(resolve => setImmediate(resolve));

// 可控时钟 + 定时器：测试里用 clock.tick(ms) 推进时间，途中的定时器会依次触发。
export function createClock(start = new Date(2026, 10, 24, 12, 0, 0).getTime()) {
  let now = start;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    pending: () => timers.size,
    Date: class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() {
        return now;
      }
    },
    setTimeout(fn, ms = 0) {
      const id = ++sequence;
      timers.set(id, { fn, at: now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async tick(ms = 0) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    }
  };
}

// 创建一个世界：返回的 window 就是 vm 沙箱的全局对象 (浏览器里 window === globalThis)。
export function createWorld({ clock = createClock(), href = 'https://aistudio.google.com/prompts/new_chat' } = {}) {
  const location = new URL(href);
  const listeners = new Map();
  const mailbox = [];      // 已投递的 { data, origin }
  const queue = [];
  const storage = new Map();
  let deliveryScheduled = false;

  const deliver = () => {
    deliveryScheduled = false;
    for (const message of queue.splice(0)) {
      mailbox.push(message);
      window.dispatch('message', { data: message.data, origin: message.origin });
    }
  };

  const window = {
    location,
    URL,
    Headers,
    Request,
    AbortController,
    TextDecoder,
    TextEncoder,
    console,
    Date: clock.Date,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    sessionStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    document: {
      hidden: false,
      documentElement: {
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        hasAttribute(name) { return this.attributes.has(name); }
      },
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(handler);
      },
      dispatch(type) {
        for (const handler of [...(listeners.get(type) || [])]) handler({ type });
      }
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    postMessage(data, origin) {
      queue.push({ data, origin });
      if (!deliveryScheduled) {
        deliveryScheduled = true;
        setImmediate(deliver);
      }
    },
    // 模拟页面或用户发来的事件；source 固定为本窗口 (沙箱内部的全局对象，见下方 global)。
    dispatch(type, event = {}) {
      for (const handler of [...(listeners.get(type) || [])]) handler({ source: global, origin: location.origin, type, ...event });
    }
  };
  window.history = {
    state: null,
    pushState(state, title, url) {
      this.state = state;
      location.href = new URL(url, location.href).href;
    },
    replaceState(state, title, url) {
      this.state = state;
      location.href = new URL(url, location.href).href;
    }
  };

  const context = vm.createContext(window);
  // vm 沙箱内部的 globalThis 与传入的 window 不是同一个对象。浏览器里 window === globalThis，
  // 所以让沙箱里的 window 也指向内部全局对象，事件里的 source 用它来比对。
  const global = vm.runInContext('globalThis', context);
  vm.runInContext('window = globalThis;', context);
  return {
    window,
    global,
    context,
    storage,
    mailbox,
    clock,
    load(...files) {
      for (const file of files) {
        vm.runInContext(readFileSync(join(ROOT, 'extension', 'src', file), 'utf8'), context, { filename: file });
      }
    },
    // 等所有排队的 postMessage 投递完。
    async settle() {
      await clock.tick(0);
      await flush();
    },
    of(type) {
      return mailbox.filter(message => message.data?.type === type).map(message => message.data);
    }
  };
}

// ---- 线上数据的造数器：与 2026-11 实测的 jspb 数组编码一致 ---------------------------------------

// 2026-11 实测：服务名前是句点，不是斜杠。
export const API = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService';
export const APP_HEADERS = {
  Authorization: 'SAPISIDHASH 1_abc',
  'Content-Type': 'application/json+protobuf',
  'X-Goog-Api-Key': 'test-key',
  'X-Goog-AuthUser': '0',
  'X-User-Agent': 'grpc-web-javascript/0.1'
};
export const AUTHOR = ['Someone', 1, 'https://example.invalid/avatar.png'];

export function record({ id, title, seconds, nanos = 50000000 }) {
  const meta = [title, null, AUTHOR, null, [[String(seconds), nanos], AUTHOR], [1, 1, 1], null, null, null, null, [],
    [['hasImages', 'false'], ['promptType', 'PROMPT_TYPE_CHAT'], ['version', '1']]];
  return [`prompts/${id}`, null, null, null, meta, null, null, null, null, null, null, null, null, []];
}

export function page(records, token) {
  return JSON.stringify(token ? [records, token] : [records]);
}

// 页面 (被测脚本眼中的"宿主应用") 发出的 ListPrompts 请求。
export function appList(world, { body = '[100]', headers = APP_HEADERS, url = `${API}/ListPrompts`, method = 'POST' } = {}) {
  const xhr = new world.window.XMLHttpRequest();
  xhr.open(method, url);
  xhr.withCredentials = true;
  for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
  xhr.send(body);
  return xhr;
}

// 假的 XMLHttpRequest：只实现被测脚本与"宿主应用"用得到的部分。
export function installXhr(world) {
  const sent = [];
  class FakeXMLHttpRequest {
    constructor() {
      this.headers = {};
      this.handlers = {};
      this.status = 0;
      this.responseText = '';
      this.responseType = '';
      this.withCredentials = false;
    }
    open(method, url) {
      this.method = String(method);
      this.url = String(url);
      return 'open-return';
    }
    setRequestHeader(name, value) {
      this.headers[name] = name in this.headers ? `${this.headers[name]}, ${value}` : String(value);
    }
    send(body) {
      this.body = body ?? null;
      sent.push(this);
    }
    addEventListener(type, handler) {
      (this.handlers[type] ||= new Set()).add(handler);
    }
    reply(status, text = '') {
      this.status = status;
      this.responseText = text;
      for (const handler of this.handlers.loadend || []) handler.call(this);
    }
  }
  world.window.XMLHttpRequest = FakeXMLHttpRequest;
  return sent;
}

// 假的 fetch：responder(call) 返回 { status, text } 或抛出的 Error。calls 记录每次调用的细节。
export function installFetch(world, responder) {
  const calls = [];
  const response = (status, text) => ({
    ok: status >= 200 && status < 300,
    status,
    clone: () => response(status, text),
    text: async () => text
  });
  world.window.fetch = async (input, init) => {
    const request = input && typeof input === 'object' ? input : null;
    const signal = (init && init.signal) || (request && request.signal) || null;
    const call = {
      url: typeof input === 'string' ? input : request.url,
      method: (init && init.method) || (request && request.method) || 'GET',
      headers: Object.fromEntries(new Headers((init && init.headers) || (request && request.headers) || undefined)),
      body: (init && init.body) ?? null,
      credentials: (init && init.credentials) || 'same-origin',
      hasSignal: !!signal
    };
    calls.push(call);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!signal) {
      const reply = await responder(call);
      return response(reply.status, reply.text);
    }
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(responder(call)).then(
        reply => {
          signal.removeEventListener('abort', onAbort);
          if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
          else resolve(response(reply.status, reply.text));
        },
        err => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  };
  return calls;
}

// ---- 通用辅助 ---------------------------------------------------------------------------------

// vm 沙箱里的对象原型与外界不同，先转成纯 JSON 再比较。
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// 加载"主世界 + 扩展世界"全链路的世界，用来端到端地检验两个世界之间的契约。
export async function setupStack({ fetchResponder = async () => ({ status: 500, text: '' }) } = {}) {
  const world = createWorld();
  const xhrs = installXhr(world);
  const fetches = installFetch(world, fetchResponder);
  world.load('protocol.js', 'prompts-parser.js', 'interceptor.js', 'history-store.js');
  await world.settle();   // 先让启动时的 HELLO 投递完，模拟真实浏览器里"就绪早于首页"的时序
  const protocol = world.window.AIPProtocol;
  return {
    world,
    xhrs,
    fetches,
    protocol,
    store: world.window.AIPHistoryStore,
    pages: () => plain(world.of(protocol.PAGE).map(data => data.payload)),
    errors: () => plain(world.of(protocol.ERROR).map(data => data.payload)),
    requests: () => plain(world.of(protocol.REQUEST).map(data => data.payload)),
    send: (type, payload) => protocol.send(type, payload)
  };
}
