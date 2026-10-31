'use strict';
// These exercise orchestration with deterministic inference/runner doubles.
// They do not execute generated code or prove Docker/model compatibility.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ProjectManager } = require('./projects.cjs');
const element = () => ({ dataset: {}, append() {}, setAttribute() {}, classList: { add() {} } });
async function workspace(t, check) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ProjectManager(root); await store.init();
  const chat = { id:'chat-a', messages: [{ role: 'user', content: 'Build a Python project' }] };
  const state = { modelChoice: 'apex-ultra', generating: false, loaded: true, chats:[chat], activeChatId:chat.id };
  let checks = 0, cancelled = false, sourceWrites = 0;
  const bridge = {
    info: async () => ({ researchConfigured: false }),
    create: value => store.create(value), read: id => store.read(id), source: id => store.source(id),
    model: async value => { const run = await store.read(value.id); run.actualModel = value.model; await store.put(run); return run; },
    event: value => store.event(value.id, value),
    projectCommand: value => { if(['WRITE_FILE','CREATE_FILE','PATCH_FILE'].includes(value.name))sourceWrites++;return store.command(value); },
    save: value => { sourceWrites++; return store.save(value.id, value.files); },
    check: async id => {
      checks++;
      const result = await check({ id, store, attempt: checks });
      const run = await store.read(id); run.lastCheck = { ...result, sourceHash: run.sourceHash }; await store.put(run);
      return result;
    },
    cancel: async () => { cancelled = true; },
    finish: async value => {
      const run = await store.read(value.id);
      run.status = value.status === 'interrupted' ? 'interrupted' : run.lastCheck?.passed ? 'checked' : 'incomplete';
      await store.put(run); return run;
    }
  };
  const engine = { interruptGenerate() {}, chat: { completions: {
    async create({ messages }) {
      const prompt = messages[1].content;
      let output;
      if (prompt.startsWith('Plan this')) output = JSON.stringify({ title: 'Example', runtime: 'python', entrypoint: 'main.py',architecture:'main.py exposes hello; unittest tests it.',
        summary: 'Write a small program and test it.', files: [{ path: 'main.py', purpose: 'program' }, { path: 'test_main.py', purpose: 'test' }], researchQuery: '' });
      else if(prompt.startsWith('Project task:')){
        const sources=chat.projectId?await store.source(chat.projectId):[];
        if(!sources.length)output=JSON.stringify({commands:[{name:'CREATE_FILE',args:{path:'main.py',content:'print("hello")\n'}},{name:'CREATE_FILE',args:{path:'test_main.py',content:'import unittest\n'}}],done:true});
        else output=JSON.stringify({commands:[{name:'PATCH_FILE',args:{path:'main.py',search:'hello',replace:'repaired'}}],done:true});
      }else throw new Error('Unexpected inference prompt');
      return (async function* () { yield { choices: [{ delta: { content: output }, finish_reason: 'stop' }] }; })();
    }
  } } };
  const ai = { engine, modelId: 'standard-ultra', async _dispose() { this.engine = null; } };
  const actionButton = element(), actionMenu = element();
  actionMenu.hidden = true; actionMenu.addEventListener = () => {};
  const context = { window: { atlasDesktop: bridge }, document: {
    documentElement: { classList: { add() {} } },
    createElement: element, createElementNS: element, createTextNode: text => text,
    querySelector: selector => selector === '#atlasActionsButton' ? actionButton : selector === '#atlasActionsMenu' ? actionMenu :
      selector === '.rail' ? { addEventListener() {} } : null,
    querySelectorAll: () => [], addEventListener() {}
  }, localStorage: { getItem: () => null, setItem() {} }, TextEncoder, AbortController, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../atlas-coding.js'), 'utf8'), context);
  const coding = context.window.AtlasCoding;
  coding.mount({ state, ai, getChat: () => chat, push(role, content) { const m = { role, content }; chat.messages.push(m); return m; },
    persist() {}, render() {}, controls() {}, updateModels() {}, ready() {}, toast() {} });
  return { coding, state, chat, store, checks: () => checks, cancelled: () => cancelled, writes: () => sourceWrites };
}
test('a failed check repairs source and reruns, while snippets remain quick', async t => {
  const env = await workspace(t, async ({ attempt }) => attempt === 1
    ? { passed: false, executed: true, checks: [{ command: 'python test_main.py', exitCode: 1, output: 'AssertionError' }], reason: 'Check failed.' }
    : { passed: true, executed: true, checks: [] });
  assert.equal(env.coding.shouldRun('Build a Python project'), true);
  assert.equal(env.coding.shouldRun('Explain Python code'), false);
  assert.equal(env.coding.shouldRun('Show a small snippet'), false);
  await env.coding.run('Build a Python project');
  const message = env.chat.messages.at(-1), run = await env.store.read(message.projectRunId);
  assert.equal(env.checks(), 2, env.chat.messages.at(-1).content);
  assert.equal(env.writes(), 3);
  assert.equal(run.status, 'checked');
  assert.ok(run.events.some(e => e.stage === 'Fixing'));
  assert.equal(env.state.generating, false);
  assert.equal(run.tasks[0].metrics.modelCalls,3);
  t.diagnostic('Mocked initial implementation + targeted repair: '+run.tasks[0].metrics.modelCalls+' model calls, '+run.tasks[0].metrics.repairAttempts+' repair, '+run.tasks[0].metrics.researchCalls+' research calls.');
});
test('missing execution prerequisites retain source and do not invent a repair', async t => {
  const env = await workspace(t, async () => ({ passed: false, executed: false, checks: [], reason: 'Docker unavailable.' }));
  await env.coding.run('Build a Python project');
  const run = await env.store.read(env.chat.messages.at(-1).projectRunId);
  assert.equal(env.checks(), 1);
  assert.equal((await env.store.source(run.id)).length, 2);
  assert.equal(run.status, 'incomplete');
  assert.match(env.chat.messages.at(-1).content, /Code not run/);
});
test('Stop during a run keeps completed files and records interruption', async t => {
  let env;
  env = await workspace(t, async () => {
    assert.equal(env.coding.cancel(), true);
    return { passed: false, executed: true, cancelled: true, checks: [], reason: 'Stopped.' };
  });
  await env.coding.run('Build a Python project');
  const run = await env.store.read(env.chat.messages.at(-1).projectRunId);
  assert.equal(run.status, 'interrupted');
  assert.equal((await env.store.source(run.id)).length, 2);
  assert.equal(env.cancelled(), true);
  assert.equal(env.state.generating, false);
});
test('follow-up chat reuses the canonical workspace and stops repeated repair evidence',async t=>{
  const env=await workspace(t,async()=>({passed:false,executed:true,checks:[{command:'test',exitCode:1,output:'same failure'}],reason:'Failed'}));
  await env.coding.run('Build a Python project');
  const id=env.chat.projectId,run=await env.store.read(id);
  assert.equal(env.checks(),2);
  assert.equal(run.tasks[0].metrics.repairAttempts,1);
  assert.ok(run.events.some(e=>e.text.includes('Repeated failure')));
  env.chat.messages.push({role:'user',content:'Make output brighter'});
  assert.equal(env.coding.shouldRun('Make output brighter'),true);
  await env.coding.run('Change text color');
  assert.equal(env.chat.projectId,id);
  assert.equal((await env.store.ids()).length,1);
  assert.equal((await env.store.read(id)).tasks.length,2);
});
test('a busy project rejection does not finish or overwrite another chat task',async t=>{
  const env=await workspace(t,async()=>({passed:true,executed:true,checks:[]}));
  const run=await env.store.create({title:'Busy',runtime:'python',entrypoint:'main.py'});env.chat.projectId=run.id;
  await env.store.command({id:run.id,name:'START_TASK',chatId:'other-chat',args:{request:'Implement feature'}});
  await env.coding.run('Build a Python project');
  const unchanged=await env.store.read(run.id);assert.equal(unchanged.status,'working');assert.equal(unchanged.tasks.length,1);assert.equal(unchanged.tasks[0].status,'working');assert.equal(env.checks(),0);
  assert.match(env.chat.messages.at(-1).projectTaskError,/PROJECT_BUSY/);
});
