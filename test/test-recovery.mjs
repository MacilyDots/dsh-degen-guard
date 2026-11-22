import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, Config } from '../lib/index.js';

const dir = mkdtempSync(join(tmpdir(), 'guard-recovery-'));
process.env.DSH_HOME = dir;
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(raw, service, editor) {
  const listeners = new Map(), routes = new Map(); let command;
  const ctx = {
    fiber: { entry: { id: 'degen-guard' } },
    get(name) { return name === 'sessionInherit' ? service : name === 'configEditor' ? editor : undefined; },
    on(name, fn) { listeners.set(name, fn); },
    inject(names, fn) {
      if (names[0] === 'commands') fn({ commands: { register(c) { command = c; } } });
      if (names[0] === 'sessionInherit') fn({ sessionInherit: service });
      if (names[0] === 'configEditor') fn({ configEditor: editor });
      if (names[0] === 'webServer') fn({ effect(f) { f(); }, webServer: { register(r) { routes.set(r.path, r.handler); return () => {}; } } });
    },
    fire(agent) {
      const h = listeners.get('agent/assistant-stream');
      h({agent, frame:{type:'start',attemptId:'a'}});
      h({agent, frame:{type:'chunk',attemptId:'a',chunk:{type:'reasoning-delta',text:'好。\n'.repeat(400)}}});
    },
  };
  apply(ctx, { maxTripsPerSession:1, handoff:false, ...raw });
  return {ctx, command, routes};
}
function agent(id, whenIdle = async () => {}) { return { id, calls: [], whenIdle, cancel(cause) { this.calls.push(cause); } }; }
const live = value => ({get: () => value});
try {
  const parsed = Config({ mode:'log', maxLineRepeat:'legacy', unknownField:42 });
  assert.equal(parsed.mode,'log'); assert.equal(parsed.maxLineRepeat,'legacy'); assert.equal(parsed.unknownField,42);
  assert.equal(parsed.onFused.get(),'hint'); assert.equal(parsed.maxAutoChain.get(),1);

  let calls=[];
  let t=setup({onFused:live('hint')},{handoff:async x=>calls.push(x)}), a=agent('session-hint');
  t.ctx.fire(a); await flush(); assert.match(a.calls[0].reason,/\/inherit session-hint/); assert.equal(calls.length,0);

  calls=[]; t=setup({onFused:live('draft')},{handoff:async x=>{calls.push(x); return {ok:true};}}); a=agent('session-draft'); t.ctx.fire(a); await flush(); assert.equal(calls[0].mode,'draft');

  const order=[];
  const svc={depthOf:()=>null, registerChildDepth:async (_p,_c,d)=>{order.push('registered'); return {registered:true,depth:d};}, handoff:async x=>{order.push('handoff'); await x.onChildCreated({childId:'child',depth:x.depth,parentSessionId:x.parentSessionId}); order.push('start'); return {ok:true};}};
  let finish; const idle=new Promise(resolve=>{finish=resolve;});
  t=setup({onFused:live('auto')},svc); a=agent('session-auto',()=>idle); t.ctx.fire(a); await flush(); assert.deepEqual(order,[]); finish(); await flush(); await flush(); assert.deepEqual(order,['handoff','registered','start']);

  calls=[]; t=setup({onFused:live('auto'),maxAutoChain:live(1)}, {depthOf:()=>({depth:1}), registerChildDepth(){}, handoff:async x=>{calls.push(x);}}); a=agent('session-limit'); t.ctx.fire(a); await flush(); assert.equal(calls[0].mode,'draft');
  calls=[]; t=setup({onFused:live('auto')}, {depthOf:()=>null, registerChildDepth(){}, handoff:async x=>{calls.push(x);}}); a=agent('session-no-idle'); delete a.whenIdle; t.ctx.fire(a); await flush(); assert.equal(calls[0].mode,'draft');
  calls=[]; t=setup({onFused:live('auto'),mode:'log'},svc); a=agent('session-log'); t.ctx.fire(a); await flush(); assert.equal(a.calls.length,0);

  let saved; let ref='hint';
  t=setup({onFused:{get:()=>ref}},undefined,{async edit(entry,change){saved=change({mode:'stop',other:9}); ref=saved.onFused;}});
  let result=await t.command.handler({rawInput:'auto'}); assert.match(result.text,/持久保存/); assert.deepEqual(saved,{mode:'stop',other:9,onFused:'auto'});
  let output; t.routes.get('/dsh-degen-guard/stats')({method:'GET'},{writeHead(){},end(body){output=JSON.parse(body);}}); assert.equal(output.effectiveOnFused,'auto');
  ref='hint'; // 之后手改 cordis.patch.yml（volatile 就地更新）——命令不得盖住 YAML
  t.routes.get('/dsh-degen-guard/stats')({method:'GET'},{writeHead(){},end(body){output=JSON.parse(body);}}); assert.equal(output.effectiveOnFused,'hint');
  t=setup({},undefined,{async edit(){throw new Error('no');}}); result=await t.command.handler({rawInput:'draft'}); assert.match(result.text,/仅本进程/);
  t.routes.get('/dsh-degen-guard/stats')({method:'GET'},{writeHead(){},end(body){output=JSON.parse(body);}}); assert.equal(output.effectiveOnFused,'draft');
  console.log('recovery tests passed (mock host and service)');
} finally { rmSync(dir,{recursive:true,force:true}); }
