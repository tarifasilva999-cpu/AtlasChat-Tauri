'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Runner}=require('./runner.cjs');const {ProjectManager}=require('./projects.cjs');
test('the actual failure ZIP cannot reach Docker or successful delivery',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-audit-runner-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new ProjectManager(root);await store.init();const run=await store.importZip(await fs.readFile(path.join(__dirname,'fixtures/card-game.zip')),'Card game');
  const runner=new Runner(store,()=>{throw new Error('Must not request a runtime download');},()=>{});
  runner.exec=()=>{throw new Error('Must audit before touching Docker');};
  const result=await runner.check(run.id);assert.equal(result.passed,false);assert.equal(result.reason,'Static audit failed.');assert.equal(result.checks[0].exitCode,1);
  assert.equal((await store.read(run.id)).lastCheck.passed,false);
});
test('materialized work preserves empty project directories and source bytes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-work-dirs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new ProjectManager(root);await store.init();const run=await store.create({title:'Folders',runtime:'web',entrypoint:'index.html'});
  const source=[{path:'index.html',content:'<h1>Ready</h1>'}];await store.save(run.id,source,0);
  await store.command({id:run.id,name:'CREATE_DIRECTORY',args:{path:'save-data',baseRevision:1}});
  const runner=new Runner(store,()=>{},()=>{}),work=await runner.prepareWork(run.id,source);
  assert.equal(work,store.workspace(run.id));
  assert.equal((await fs.stat(path.join(work,'save-data'))).isDirectory(),true);assert.equal(await fs.readFile(path.join(work,'index.html'),'utf8'),source[0].content);
  await runner.cleanupWork(run.id);assert.equal(await fs.readFile(path.join(work,'index.html'),'utf8'),source[0].content);
});
test('project commands mount the persistent workspace and separate project dependencies',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-runtime-mount-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new ProjectManager(root);await store.init();const run=await store.create({title:'Runtime',runtime:'python',entrypoint:'main.py'});
  const runner=new Runner(store,()=>{},async()=>{});let args;
  runner.exec=async value=>{args=value;return {exitCode:0,output:'ok'};};
  await runner.command({id:run.id,cancelled:false},'image',store.workspace(run.id),['python','main.py']);
  assert.ok(args.includes(store.workspace(run.id)+':/workspace:rw'));
  assert.ok(args.includes(path.join(store.dir(run.id),'environment','venv')+':/workspace/.venv:rw'));
  assert.ok(args.includes(path.join(store.dir(run.id),'environment','node_modules')+':/workspace/node_modules:rw'));
});
