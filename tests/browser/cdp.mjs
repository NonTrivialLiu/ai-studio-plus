/**
 * 极简 Chrome DevTools Protocol 客户端：用 Node 自带的 WebSocket 驱动本机的 Chromium。
 * 只实现测试需要的能力 (开标签页、执行脚本、设置视口)，不引入任何依赖。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { findChromium } from '../../scripts/chromium.mjs';

const DEFAULT_CMD_TIMEOUT_MS = 15000;

export class Browser {
  constructor(process_, socket, profileDir) {
    this.process = process_;
    this.socket = socket;
    this.profileDir = profileDir;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;

    const rejectAll = reason => {
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        this.pending.delete(id);
        waiter.reject(new Error(`${waiter.method}: ${reason}`));
      }
    };

    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
        else waiter.resolve(message.result);
        return;
      }
      for (const handler of this.handlers) handler(message);
    });
    socket.addEventListener('error', () => {
      this.closed = true;
      rejectAll('CDP WebSocket 连接错误');
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      rejectAll('CDP WebSocket 连接已断开');
    });
  }

  static async launch({ executable, extensionDir, width = 1280, height = 900 }) {
    const profileDir = join(tmpdir(), `aip-test-profile-${process.pid}-${Date.now()}`);
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      `--window-size=${width},${height}`,
      ...(process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])
    ];
    if (extensionDir) args.push(`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`);
    args.push('about:blank');
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('exit', onExit);
        fn(value);
      };
      const onData = chunk => {
        output += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match) done(resolve, match[1]);
      };
      const onExit = code => done(reject, new Error(`浏览器提前退出 (code ${code})：${output.slice(-600)}`));
      const timer = setTimeout(() => done(reject, new Error(`等待浏览器启动超时：${output.slice(-600)}`)), 20000);
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', onExit);
    });
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('连不上浏览器的调试端口')), { once: true });
    });
    return new Browser(child, socket, profileDir);
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(method, params = {}, sessionId, timeoutMs = DEFAULT_CMD_TIMEOUT_MS) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${method}: CDP WebSocket 未连接`));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: CDP 命令超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  // 新开一个标签页并绑定视口。返回的句柄可以直接执行脚本。
  async newTab({ width = 1280, height = 900 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const errors = [];
    const offError = this.onEvent(message => {
      if (message.sessionId !== sessionId || message.method !== 'Runtime.exceptionThrown') return;
      const details = message.params?.exceptionDetails;
      errors.push({
        text: details?.text || 'Uncaught exception',
        description: details?.exception?.description || details?.text || ''
      });
    });
    const tab = {
      targetId,
      sessionId,
      errors,
      assertNoErrors: () => {
        if (!errors.length) return;
        const summary = errors.map(err => err.description || err.text).join('\n');
        throw new Error(`页面发生未捕获异常 (${errors.length}):\n${summary}`);
      },
      goto: async url => {
        await this.send('Page.navigate', { url }, sessionId);
        await tab.waitFor(() => tab.evaluate(() => document.readyState !== 'loading'), { timeout: 15000 });
      },
      evaluate: async (fn, arg) => {
        const expression = typeof fn === 'function' ? `(${fn})(${JSON.stringify(arg ?? null)})` : fn;
        const reply = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (reply.exceptionDetails) {
          const detail = reply.exceptionDetails.exception?.description || reply.exceptionDetails.text;
          throw new Error(`页面脚本出错：${detail}`);
        }
        return reply.result.value;
      },
      waitFor: async (condition, { timeout = 10000, interval = 50, message = '条件' } = {}) => {
        const until = Date.now() + timeout;
        for (;;) {
          const value = await condition();
          if (value) return value;
          if (Date.now() > until) throw new Error(`等待超时：${message}`);
          await new Promise(resolve => setTimeout(resolve, interval));
        }
      },
      close: async ({ allowErrors = false } = {}) => {
        offError();
        try {
          if (!allowErrors) tab.assertNoErrors();
        } finally {
          await this.send('Target.closeTarget', { targetId }).catch(() => {});
        }
      }
    };
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    return tab;
  }

  async close() {
    try {
      await this.send('Browser.close', {}, undefined, 5000);
    } catch (_) {}
    this.closed = true;
    this.socket.close();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      const ac = new AbortController();
      const killTimer = setTimeout(() => {
        try { this.process.kill('SIGKILL'); } catch (_) {}
      }, 3000);
      const hardTimer = setTimeout(() => ac.abort(), 5000);
      try {
        await once(this.process, 'exit', { signal: ac.signal });
      } catch (_) {
      } finally {
        clearTimeout(killTimer);
        clearTimeout(hardTimer);
      }
    }
    try {
      rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (_) {}   // 浏览器可能还在写配置目录；清不掉也只是临时目录里多几个文件
  }
}

// 简易断言收集：让一份脚本既能跑测试，也能打印易读的结果。
export function createSuite(title) {
  const results = [];
  return {
    async test(name, fn) {
      const started = Date.now();
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
      } catch (error) {
        results.push({ name, ok: false, error });
        console.log(`  ✗ ${name}\n      ${String(error.message || error).split('\n').join('\n      ')}`);
      }
    },
    skip(name) {
      console.log(`  − ${name} (跳过)`);
    },
    summary() {
      const failed = results.filter(result => !result.ok);
      console.log(`\n${title}：${results.length - failed.length}/${results.length} 通过${failed.length ? '，失败 ' + failed.map(result => result.name).join('、') : ''}`);
      return failed.length === 0;
    }
  };
}
