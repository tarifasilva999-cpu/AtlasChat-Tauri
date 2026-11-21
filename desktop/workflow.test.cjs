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
const element = tagName => ({
  tagName, dataset: {}, children: [],
  append(...items) { this.children.push(...items); },
  replaceChildren(...items) { this.children = items; },
  setAttribute() {}, classList: { add() {}, remove() {} }
});
async function workspace(t, check, {persistent = true, singleFile = false, generate} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ProjectManager(path.join(root, 'projects')); await store.init();
  const chat = { id:'chat-a', messages: [{ role: 'user', content: 'Build a Python project' }] };
  if (persistent) chat.projectId = (await store.create({title:'Example',runtime:'python',entrypoint:'main.py'})).id;
  const state = { modelChoice: 'apex-ultra', generating: false, loaded: true, chats:[chat], activeChatId:chat.id };
  let checks = 0, cancelled = false, sourceWrites = 0;
  const downloads = [];
  const bridge = {
    info: async () => ({ researchConfigured: false }),
    createScratch: value => store.createScratch(value), read: id => store.read(id), source: id => store.source(id),
    model: async value => { const run = await store.read(value.id); run.actualModel = value.model; await store.put(run); return run; },
    event: value => store.event(value.id, value),
    projectCommand: async value => {
      if (value.name === 'SAVE_CODING_ARTIFACT') return store.saveCodingArtifact(value.id, value.args.previousSourceHash, value.args.sourceHash);
      if (value.name === 'DOWNLOAD_CODING_ARTIFACT') {
        downloads.push(await store.readCodingArtifact(value.id, value.args.filename));
        return true;
      }
      if(['WRITE_FILE','CREATE_FILE','PATCH_FILE'].includes(value.name))sourceWrites++;
      return store.command(value);
    },
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
    async create({ messages, _atlasKind }) {
      assert.ok(['project','project-action','project-html'].includes(_atlasKind));
      const prompt = messages[1].content;
      const custom = generate?.(prompt);
      if (custom) return (async function* () {
        yield { choices: [{ delta: { content: custom.content }, finish_reason: custom.finish || 'stop' }] };
      })();
      let output;
      if (prompt.startsWith('Plan this')) output = JSON.stringify({ title: 'Example', runtime: 'python', entrypoint: 'main.py',architecture:'main.py is the program entrypoint.',
        summary: 'Write a small program.', files: [{ path: 'main.py', purpose: 'program' }, ...(!singleFile ? [{ path: 'test_main.py', purpose: 'test' }] : [])] });
      else if(prompt.startsWith('Project task:')){
        const sources=await store.source(chat.projectId || chat.scratchWorkspaceId);
        if(!sources.length)output=JSON.stringify({commands:[{name:'CREATE_FILE',args:{path:'main.py',content:'print("hello")\n'}},
          ...(!singleFile ? [{name:'CREATE_FILE',args:{path:'test_main.py',content:'import unittest\n'}}] : [])],done:true,summary:'The script prints hello.'});
        else output=JSON.stringify({commands:[{name:'PATCH_FILE',args:{path:'main.py',search:'hello',replace:'repaired'}}],done:true,summary:'The script prints the updated message.'});
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
  return { coding, state, chat, store, downloads, checks: () => checks, cancelled: () => cancelled, writes: () => sourceWrites };
}
test('a cut-off coding action compacts context and resumes in saved chunks past the old call limit', async t => {
  let attempt = 0, invalidAction = false;
  const env = await workspace(t, async () => ({passed:true,executed:true,behaviorVerified:true,checks:[]}), {
    persistent:false, singleFile:true,
    generate(prompt) {
      if (!prompt.startsWith('Project task:')) return;
      assert.match(prompt, /Build a Python project/);
      assert.match(prompt, /main.py is the program entrypoint/);
      if (attempt === 1 && !invalidAction) {
        assert.match(prompt, /previous response was cut off/);
        invalidAction = true;
        return {content: '{"commands":[{"name":"CodeEdit","args":{}}]}'};
      }
      const step = attempt++;
      if (!step) return {content:'{"commands":[{"name":"CREATE_FILE"',finish:'length'};
      if (step === 1) {
        assert.match(prompt,/previous response was not a valid project action/);
        assert.match(prompt,/exactly one command/);
        assert.doesNotMatch(prompt,/Earlier project tasks:/);
      } else {
        assert.ok(prompt.includes('Continue after line ' + (step - 1)));
        assert.ok(prompt.includes('print(' + (step - 1) + ')'));
      }
      return {content:JSON.stringify({
        commands:[{name:step === 1 ? 'CREATE_FILE' : 'APPEND_FILE',args:{path:'main.py',content:'print(' + step + ')\n'}}],
        done:step === 12, progress:'Continue after line ' + step, summary:'The script prints twelve numbers.'
      })};
    }
  });
  await env.coding.run('Build a Python project');
  const message = env.chat.messages.at(-1);
  assert.equal(message.projectTaskError, undefined);
  const run = await env.store.read(message.scratchRunId);
  const [file] = await env.store.source(run.id);
  assert.equal(file.content, Array.from({length:12}, (_, i) => 'print(' + (i + 1) + ')\n').join(''));
  assert.equal(run.tasks[0].metrics.modelCalls, 15);
  assert.ok(run.events.some(event => event.stage === 'Compacting context'));
  assert.equal(message.codingArtifact.draft, false);
});

test('the generation limit setting stops a cut-off action without applying it', async t => {
  const env = await workspace(t, async () => { throw new Error('Unexpected check'); }, {
    persistent:false, singleFile:true,
    generate:prompt => prompt.startsWith('Project task:') ? {content:'{"commands":[',finish:'length'} : undefined
  });
  env.coding.restorePreferences({limitGeneration:true});
  await env.coding.run('Build a Python project');
  const message = env.chat.messages.at(-1);
  assert.match(message.projectTaskError, /Limit coding generation/);
  assert.deepEqual(await env.store.source(message.scratchRunId), []);
  assert.equal(env.checks(), 0);
});

test('a failed check repairs source and reruns, while snippets remain quick', async t => {
  const env = await workspace(t, async ({ attempt }) => attempt === 1
    ? { passed: false, executed: true, checks: [{ command: 'python test_main.py', exitCode: 1, output: 'AssertionError' }], reason: 'Check failed.' }
    : { passed: true, executed: true, checks: [] });
  assert.equal(env.coding.shouldRun('Build a Python project'), true);
  assert.equal(env.coding.shouldRun('Explain Python code'), false);
  assert.equal(env.coding.shouldRun('Show a small snippet'), false);
  assert.equal(env.coding.shouldRun('Brainstorm how we could implement this, without changing files'),false);
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
  const shared=JSON.parse(await env.coding.projectContextForChat(env.chat.id,'Build a Python project'));
  assert.match(shared.recentProjectWork,/Build a Python project/);
  assert.ok(run.tasks[0].events.some(event=>event.stage==='Planning'));
  env.chat.messages.push({role:'user',content:'Make output brighter'});
  assert.equal(env.coding.shouldRun('Make output brighter'),true);
  assert.equal(env.coding.shouldRun('Yes, go ahead'),true);
  await env.coding.run('Change text color');
  assert.equal(env.chat.projectId,id);
  assert.equal((await env.store.ids()).length,1);
  assert.equal((await env.store.read(id)).tasks.length,2);
});
test('a busy project rejection does not finish or overwrite another chat task',async t=>{
  const env=await workspace(t,async()=>({passed:true,executed:true,checks:[]}),{persistent:false});
  const run=await env.store.create({title:'Busy',runtime:'python',entrypoint:'main.py'});env.chat.projectId=run.id;
  await env.store.command({id:run.id,name:'START_TASK',chatId:'other-chat',args:{request:'Implement feature'}});
  await env.coding.run('Build a Python project');
  const unchanged=await env.store.read(run.id);assert.equal(unchanged.status,'working');assert.equal(unchanged.tasks.length,1);assert.equal(unchanged.tasks[0].status,'working');assert.equal(env.checks(),0);
  assert.match(env.chat.messages.at(-1).projectTaskError,/PROJECT_BUSY/);
});

test('normal coding chat saves a single file per revision and keeps earlier downloads', async t => {
  const env = await workspace(t, async () => ({passed:true,executed:true,behaviorVerified:true,checks:[]}), {persistent:false,singleFile:true});
  assert.equal(env.coding.shouldRun('Can you code a greeting for me?'), true);
  await env.coding.run('Can you code a greeting in Python for me?');
  const first = env.chat.messages.at(-1);
  assert.equal(first.content, 'The script prints hello. Behavior checks passed.');
  assert.equal(first.codingArtifact.filename, 'main.py');
  assert.equal(env.coding.shouldRun('Change the greeting', env.chat, true), true);
  assert.equal(env.coding.shouldRun('Show me the code', env.chat, true), false);
  await env.coding.run('Change the greeting');
  const second = env.chat.messages.at(-1);
  assert.equal(first.scratchRunId, second.scratchRunId);
  assert.notEqual(first.codingArtifact.id, second.codingArtifact.id);
  assert.equal((await env.store.list()).length, 0);
  await env.store.cleanupExpiredScratch(Infinity);
  for (const message of [first, second]) {
    const container = element('div');
    env.coding.render(container, message);
    assert.deepEqual(container.children.map(child => child.tagName), ['p', 'div']);
    assert.equal(container.children[0].textContent, message.content);
    const download = container.children[1].children.at(-1);
    assert.equal(download.textContent, 'Download');
    await download.onclick();
  }
  assert.deepEqual(env.downloads.map(data => data.toString()), ['print("hello")\n', 'print("repaired")\n']);
});

test('normal coding chat saves multiple files as a ZIP when execution is unavailable', async t => {
  const env = await workspace(t, async () => ({passed:false,executed:false,checks:[],reason:'Docker unavailable.'}), {persistent:false});
  await env.coding.run('Build a Python project');
  const message = env.chat.messages.at(-1), artifact = message.codingArtifact;
  assert.match(message.content, /Code not run\. Docker unavailable\./);
  assert.match(artifact.filename, /\.zip$/);
  const {unzipSync} = require('fflate');
  const zip = unzipSync(await env.store.readCodingArtifact(artifact.id, artifact.filename));
  assert.deepEqual(Object.keys(zip).sort(), ['main.py', 'test_main.py']);
});

test('coding failure follow-ups use the saved error and actual download status', async t => {
  const request = 'can you code me a random thing, surprise me. and return it to me as a downloadable file';
  const env = await workspace(t, async () => assert.fail('An invalid action must not reach checks'), {
    persistent:false,
    generate:() => ({content:'I can write a downloadable file.'})
  });
  env.chat.messages[0].content = request;
  assert.equal(env.coding.shouldRun(request), true);
  await env.coding.run(request);
  const previous = env.chat.messages.at(-1);
  assert.match(previous.projectTaskError, /invalid workspace action/);
  assert.equal(previous.codingArtifact, undefined);
  assert.equal(env.coding.explainTaskFailure('whyd task end early?', env.chat),
    previous.projectTaskError + ' This task did not produce a download.');
  assert.equal(env.coding.explainTaskFailure('make me a file', env.chat), '');
  previous.projectTaskError = 'Atlas could not produce a complete project action. Saved files were kept.';
  previous.codingArtifact = {draft:true};
  assert.match(env.coding.explainTaskFailure('why did it stop?', env.chat), /Limit coding generation turned off.*saved draft/);
});

test('an open-ended download saves a standalone HTML file without a separate model plan', async t => {
  const request = 'can you code me a random thing, surprise me. and return it to me as a downloadable file';
  const html = '<!doctype html><html><title>Surprise</title><button>Click me</button></html>';
  const env = await workspace(t, async ({ attempt }) => attempt === 1
    ? {passed:false,executed:true,checks:[{command:'Static audit',exitCode:1,output:'Unexpected end of input'}]}
    : {passed:true,executed:true,behaviorVerified:true,checks:[]}, {
    persistent:false,
    generate(prompt) {
      assert.match(prompt, /^User request:/);
      assert.match(prompt, /must work when opened from disk/);
      if (!prompt.includes('Check failure:')) return {content: JSON.stringify({html:'<!doctype html><html><script>(() => {</script></html>'})};
      assert.match(prompt, /Unexpected end of input/);
      return {content: JSON.stringify({html})};
    }
  });
  await env.coding.run(request);
  const message = env.chat.messages.at(-1);
  assert.equal(message.projectTaskError, undefined, message.content);
  assert.equal(message.codingArtifact.filename, 'index.html');
  assert.equal((await env.store.readCodingArtifact(message.codingArtifact.id, 'index.html')).toString(), html);
});
