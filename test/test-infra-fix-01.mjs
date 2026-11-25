import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { apply } from '../lib/index.js';

const dir = mkdtempSync(join(tmpdir(), 'infra-fix-01-'));
process.env.DSH_HOME = dir;
const flush = () => new Promise((r) => setImmediate(r));

function createHost({ root, throwOnRoute = false } = {}) {
  const listeners = new Map();
  const routes = new Map();
  const disposers = [];
  const ctx = {
    root,
    fiber: { entry: { id: 'degen-guard' } },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      return () => {
        const arr = listeners.get(name) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return () => { if (typeof d === 'function') d(); };
    },
    inject(names, fn) {
      if (names[0] === 'sessionInherit') fn({ sessionInherit: ctx._service });
      if (names[0] === 'webServer') {
        fn({
          effect(f) {
            const d = f();
            if (typeof d === 'function') disposers.push(d);
            return () => { if (typeof d === 'function') d(); };
          },
          webServer: {
            register(r) {
              if (throwOnRoute) throw new Error('mock route failure');
              routes.set(r.path, r.handler);
              return () => routes.delete(r.path);
            },
          },
        });
      }
    },
    dispose() {
      while (disposers.length) {
        const d = disposers.pop();
        try { d(); } catch {}
      }
    },
    fire(agent) {
      for (const fn of listeners.get('agent/assistant-stream') || []) {
        fn({ agent, frame: { type: 'start', attemptId: 'a1' } });
        fn({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'reasoning-delta', text: '好。\n'.repeat(400) } } });
      }
    },
    listenerCount(name) {
      return (listeners.get(name) || []).length;
    },
  };
  return { ctx, routes };
}

function makeAgent(id) {
  return { id, calls: [], whenIdle: async () => {}, cancel(c) { this.calls.push(c); } };
}

try {
  // 1. draft -> auto 继承链深度绕过回归测试
  {
    const depths = new Map();
    const handoffs = [];
    const svc = {
      depthOf: (id) => (depths.has(id) ? { depth: depths.get(id) } : null),
      registerChildDepth: async (_p, childId, d) => {
        depths.set(childId, d);
        return { registered: true, depth: d };
      },
      handoff: async (req) => {
        handoffs.push(req);
        const childId = `child-${handoffs.length}`;
        if (typeof req.onChildCreated === 'function') {
          await req.onChildCreated({ childId, depth: req.depth, parentSessionId: req.parentSessionId });
        }
        return { ok: true, childId };
      },
    };

    // 第一步：根会话 S0 在 draft 模式熔断，生成子会话 child-1
    const h1 = createHost();
    h1.ctx._service = svc;
    apply(h1.ctx, { maxTripsPerSession: 1, handoff: false, onFused: 'draft', maxAutoChain: 1 });
    h1.ctx.fire(makeAgent('S0'));
    await flush();
    assert.equal(handoffs[0].mode, 'draft');
    assert.equal(depths.get('child-1'), 1, 'draft 子会话必须登记深度为 1');

    // 第二步：child-1 切换到 auto 模式再次熔断（maxAutoChain=1），必须降级为 draft
    const h2 = createHost();
    h2.ctx._service = svc;
    apply(h2.ctx, { maxTripsPerSession: 1, handoff: false, onFused: 'auto', maxAutoChain: 1 });
    h2.ctx.fire(makeAgent('child-1'));
    await flush();
    assert.equal(handoffs[1].mode, 'draft', 'draft->auto 链深度已达上限，必须降级为 draft');
  }

  // 2. 深度登记失败：auto 拒绝启动；draft 仅记录日志不抛错阻塞
  {
    const handoffs = [];
    const svcFail = {
      depthOf: () => null,
      registerChildDepth: async () => ({ error: 'ledger-io-error' }),
      handoff: async (req) => {
        handoffs.push(req);
        if (typeof req.onChildCreated === 'function') {
          await req.onChildCreated({ childId: 'child-fail', depth: req.depth, parentSessionId: req.parentSessionId });
        }
        return { ok: true };
      },
    };

    const hAuto = createHost();
    hAuto.ctx._service = svcFail;
    apply(hAuto.ctx, { maxTripsPerSession: 1, handoff: false, onFused: 'auto', maxAutoChain: 1 });
    await assert.doesNotReject(async () => {
      hAuto.ctx.fire(makeAgent('S-auto-fail'));
      await flush();
    });
    const logText = readFileSync(join(dir, 'logs', 'dsh-degen-guard.log'), 'utf8');
    assert.match(logText, /child depth registration failed/);

    const hDraft = createHost();
    hDraft.ctx._service = svcFail;
    apply(hDraft.ctx, { maxTripsPerSession: 1, handoff: false, onFused: 'draft', maxAutoChain: 1 });
    hDraft.ctx.fire(makeAgent('S-draft-fail'));
    await flush();
    const logText2 = readFileSync(join(dir, 'logs', 'dsh-degen-guard.log'), 'utf8');
    assert.match(logText2, /draft-depth-registration-failed/);
  }

  // 3. 损坏/负深度记录 fail-closed（降级到 hint，不自动启动）
  {
    const handoffs = [];
    const hCorrupt = createHost();
    hCorrupt.ctx._service = {
      depthOf: () => ({ depth: -1 }),
      registerChildDepth: async () => ({ registered: true, depth: 0 }),
      handoff: async (req) => { handoffs.push(req); return { ok: true }; },
    };
    apply(hCorrupt.ctx, { maxTripsPerSession: 1, handoff: false, onFused: 'auto', maxAutoChain: 1 });
    hCorrupt.ctx.fire(makeAgent('S-corrupt'));
    await flush();
    assert.equal(handoffs.length, 0, '非法深度记录必须 fail-closed，不得调用 handoff');
  }

  // 4. 同进程同宿主（共享 ctx.root）重复注册互斥 + 热重载释放 + 失败清理
  {
    const sharedRoot = { id: 'cordis-root-1' };
    const hA = createHost({ root: sharedRoot });
    const hB = createHost({ root: sharedRoot });
    apply(hA.ctx, { maxTripsPerSession: 1, handoff: false });
    apply(hB.ctx, { maxTripsPerSession: 1, handoff: false });
    assert.equal(hA.ctx.listenerCount('agent/assistant-stream'), 1);
    assert.equal(hB.ctx.listenerCount('agent/assistant-stream'), 0, '同宿主重复注册必须跳过第二个实例');
    const logText = readFileSync(join(dir, 'logs', 'dsh-degen-guard.log'), 'utf8');
    assert.match(logText, /duplicate-registration-skipped/);

    // 热重载：卸载 hA 后，hB 应可正常注册
    hA.ctx.dispose();
    apply(hB.ctx, { maxTripsPerSession: 1, handoff: false });
    assert.equal(hB.ctx.listenerCount('agent/assistant-stream'), 1, '卸载释放后应允许热重载重新注册');
    hB.ctx.dispose();

    // 注册失败清理：webServer.register 抛错后，不应死锁后续注册
    const hFail = createHost({ root: sharedRoot, throwOnRoute: true });
    assert.throws(() => apply(hFail.ctx, { maxTripsPerSession: 1, handoff: false }), /mock route failure/);
    const hRecover = createHost({ root: sharedRoot });
    apply(hRecover.ctx, { maxTripsPerSession: 1, handoff: false });
    assert.equal(hRecover.ctx.listenerCount('agent/assistant-stream'), 1, '注册失败清理后应允许重新注册');
    hRecover.ctx.dispose();
  }

  // 5. 多 Profile（不同 OS 进程）互不阻塞
  {
    const script = `
      import { apply } from './lib/index.js';
      const listeners = [];
      const root = { id: 'shared-name-different-process' };
      apply({ root, on(n, f){ listeners.push(n); return ()=>{}; }, effect(f){ return f()||(()=>{}); }, inject(){} }, {});
      console.log('COUNT=' + listeners.length);
    `;
    const p1 = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
    const p2 = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(p1.status, 0);
    assert.equal(p2.status, 0);
    assert.match(p1.stdout, /COUNT=3/);
    assert.match(p2.stdout, /COUNT=3/);
  }

  console.log('test-infra-fix-01: ALL PASSED');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
