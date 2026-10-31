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
  assert.equal((await fs.stat(path.join(work,'save-data'))).isDirectory(),true);assert.equal(await fs.readFile(path.join(work,'index.html'),'utf8'),source[0].content);
});
