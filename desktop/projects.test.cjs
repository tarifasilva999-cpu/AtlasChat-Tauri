'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ProjectManager,POLICIES}=require('./projects.cjs');
const {Store,fingerprint}=require('./core.cjs');
const {bytes}=require('./project-audit.cjs');
const {zipSync,unzipSync}=require('fflate');
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-projects-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const manager=new ProjectManager(root);await manager.init();const run=await manager.create({title:'Test',runtime:'web',entrypoint:'index.html'});const cmd=(name,args={},extra={})=>manager.command({id:run.id,name,args,...extra});return {manager,run,cmd,root};}

test('project deletion removes only the selected workspace and refuses active tasks',async t=>{
  const {manager,run,root}=await setup(t);
  const other=await manager.create({title:'Keep',runtime:'web',entrypoint:'index.html'});
  await manager.save(run.id,[{path:'index.html',content:'draft'}],0);
  const state=await manager.state(run.id);state.run.tasks.push({id:'active',status:'working'});await manager.commit(run.id,state);
  await assert.rejects(manager.remove(run.id),/active project task/);
  assert.equal((await manager.source(run.id))[0].content,'draft');
  state.run.tasks[0].status='interrupted';await manager.commit(run.id,state);
  await assert.rejects(manager.remove('../outside'),/Invalid/);
  await manager.remove(run.id);
  await assert.rejects(fs.stat(path.join(root,run.id)),{code:'ENOENT'});
  assert.equal((await manager.read(other.id)).title,'Keep');
  assert.deepEqual((await manager.list()).map(project=>project.id),[other.id]);
});
test('persistent workspace, two chats, atomic optimistic edits, and stale hash protection',async t=>{
  const {manager,run,cmd,root}=await setup(t);
  await manager.save(run.id,[{path:'index.html',content:'<button id="x">a</button>'}],0);
  await cmd('ATTACH_CHAT',{}, {chatId:'a'});await cmd('ATTACH_CHAT',{}, {chatId:'b'});
  const old=await cmd('READ_FILE',{path:'index.html'});
  const attempts=await Promise.allSettled(['b','c'].map(content=>cmd('WRITE_FILE',{path:'index.html',content,baseRevision:1,baseHash:old.hash})));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  assert.match(attempts.find(r=>r.status==='rejected').reason.message,/CONFLICT/);
  const reopened=new ProjectManager(root);assert.equal((await reopened.read(run.id)).revision,2);
  assert.equal((await reopened.source(run.id))[0].content,'b');
  assert.deepEqual((await reopened.read(run.id)).chats,['a','b']);
  await assert.rejects(cmd('WRITE_FILE',{path:'index.html',content:'stale',baseRevision:2,baseHash:old.hash}),/HASH_CONFLICT/);
});
test('checkpoints restore source and shared decisions, invalidating verification',async t=>{
  const {manager,run,cmd}=await setup(t);await manager.save(run.id,[{path:'index.html',content:'old'}],0);
  await cmd('SET_PROJECT_MEMORY',{baseRevision:1,memory:{decision:'canonical'}});
  const cp=await cmd('CHECKPOINT',{label:'Known working'});
  await manager.save(run.id,[{path:'index.html',content:'bad'}],2);
  const diff=await cmd('DIFF_CHECKPOINT',{checkpointId:cp.id});
  assert.equal(diff.changes[0].path,'index.html');assert.match(diff.changes[0].diff,/- old/);assert.match(diff.changes[0].diff,/\+ bad/);
  await cmd('ROLLBACK',{baseRevision:3,checkpointId:cp.id});
  assert.equal((await manager.source(run.id))[0].content,'old');
  assert.equal((await manager.read(run.id)).memory.decision,'canonical');
  assert.equal((await manager.read(run.id)).lastCheck,null);
});
test('real attached card-game specimen is rejected before runtime or delivery',async t=>{
  const {manager}=await setup(t),data=await fs.readFile(path.join(__dirname,'fixtures/card-game.zip'));
  const imported=await manager.importZip(data,'Broken card game');
  const result=await manager.command({id:imported.id,name:'AUDIT'});
  assert.equal(result.passed,false);
  assert.ok(result.errors.some(e=>e.code==='REFERENCE_MISSING'&&e.message.includes('scripts/build.js')));
  assert.ok(result.errors.some(e=>e.file==='cards.png'&&e.code==='ASSET_INVALID'));
  assert.ok(result.errors.some(e=>e.code==='SYNTAX_INVALID'));
  assert.ok(result.errors.some(e=>e.code==='ASSET_LAYOUT_MISSING'));
  assert.notEqual((await manager.read(imported.id)).status,'checked');
});
test('syntax, import names, missing references, malformed config, and image signatures',async t=>{
  const {manager,run,cmd}=await setup(t);
  await manager.save(run.id,[{path:'index.html',content:'<script type="module" src="main.js"></script><img src="bad.png">'},
    {path:'main.js',content:'import {missing} from "./dep.js";'}, {path:'dep.js',content:'export const present=1;'},
    {path:'bad.png',content:'ASCII drawing'}, {path:'oops.js',content:'function broken( {'}, {path:'bad.json',content:'{oops'}],0);
  const audit=await cmd('AUDIT');assert.equal(audit.passed,false);
  for(const code of ['EXPORT_MISSING','ASSET_INVALID','SYNTAX_INVALID','CONFIG_INVALID'])assert.ok(audit.errors.some(e=>e.code===code),code);
});
test('ZIP bytes/folders round-trip and traversal/duplicate/expansion protection',async t=>{
  const {manager,run,cmd}=await setup(t);const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=','base64');
  await manager.save(run.id,[{path:'index.html',content:'<img src="assets/a.png">'},{path:'assets/a.png',content:png.toString('base64'),encoding:'base64'}],0);
  await cmd('CREATE_DIRECTORY',{path:'empty',baseRevision:1});
  const zipped=await manager.zip(run.id),entries=unzipSync(zipped);assert.deepEqual(Buffer.from(entries['assets/a.png']),png);assert.ok(entries['empty/']);
  const other=await manager.importZip(zipped,'Imported');assert.equal(other.runtime,'web');assert.deepEqual(bytes((await manager.source(other.id)).find(f=>f.path==='assets/a.png')),png);
  assert.ok(other.directories.includes('empty'));
  await assert.rejects(manager.importZip(zipSync({'../escape':Buffer.from('x')}),'Bad'),/relative/);
  await assert.rejects(manager.importZip(zipSync({'a':Buffer.from('x'),'A':Buffer.from('y')}),'Bad'),/Duplicate/);
  await assert.rejects(manager.importZip(zipSync({'large.txt':Buffer.alloc(9*1024*1024)}),'Bad'),/limit/);
});
test('large projects select bounded movement context and retain dependency indexes',async t=>{
  const {manager,run,cmd}=await setup(t);const source=[{path:'index.html',content:'<script type="module" src="src/player.js"></script>'},{path:'src/player.js',content:'import {gravity} from "./physics.js"; export function jump(){return gravity;}'},{path:'src/physics.js',content:'export const gravity=9.8;'},...Array.from({length:300},(_,i)=>({path:'docs/file'+i+'.txt',content:'unrelated '.repeat(100)}))];
  await manager.save(run.id,source,0);const context=await cmd('SELECT_CONTEXT',{request:'Make jumping gravity heavier',budget:1200});
  assert.ok(context.files.some(f=>f.path==='src/player.js'));assert.ok(context.files.some(f=>f.path==='src/physics.js'));
  assert.ok(context.files.length<=5);assert.ok(context.files.reduce((n,f)=>n+f.content.length,0)<=1200);
  t.diagnostic('Context retrieval: '+context.files.length+'/'+source.length+' files; '+context.files.reduce((n,f)=>n+f.content.length,0)+' source characters (1,200 character cap).');
  assert.deepEqual((await cmd('GET_DEPENDENTS',{path:'src/physics.js'})).files,['src/player.js']);
  const a=manager.index(run.id,source),b=manager.index(run.id,source);assert.equal(a['src/player.js'],b['src/player.js']);
});
test('call budgets, adaptive repair stall, research escalation, telemetry and recovery',async t=>{
  const {manager,run,cmd,root}=await setup(t);const task=await cmd('START_TASK',{request:'Change CSS spacing'},{chatId:'a'});
  assert.equal(task.complexity,'small');const c=(name,args={})=>cmd(name,args,{taskId:task.id,chatId:'a'});
  assert.equal((await c('RESEARCH_PERMISSION',{question:'API question'})).allowed,false);
  const errors=[{file:'a',message:'Same failure'}];assert.equal((await c('NEXT_REPAIR',{errors})).allowed,true);assert.equal((await c('NEXT_REPAIR',{errors})).allowed,false);
  for(let i=0;i<POLICIES.small.calls;i++)await c('RECORD_CALL',{inputChars:100});
  await assert.rejects(c('RECORD_CALL'),/BUDGET/);assert.equal((await manager.read(run.id)).tasks[0].metrics.inputChars,400);
  const reopened=new ProjectManager(root);await reopened.recover();assert.equal((await reopened.read(run.id)).tasks[0].status,'interrupted');
});
test('legacy runs migrate to Projects without copying or losing source',async t=>{
  const {root}=await setup(t),legacy=new Store(root);const run=await legacy.create({title:'Legacy',runtime:'python',entrypoint:'main.py'});
  await legacy.save(run.id,[{path:'main.py',content:'print(1)'}]);const manager=new ProjectManager(root);
  const current=await manager.read(run.id);assert.equal(current.version,3);await manager.command({id:run.id,name:'CHECKPOINT'});
  assert.equal((await manager.source(run.id))[0].content,'print(1)');assert.equal((await manager.read(run.id)).id,run.id);
});
test('ZIP-backed projects migrate into a persistent workspace and export its current files',async t=>{
  const {manager,run,root}=await setup(t);await manager.save(run.id,[{path:'src/main.js',content:'old'}],0);
  const metadataPath=path.join(manager.dir(run.id),'workspace.json');
  const metadata=JSON.parse(await fs.readFile(metadataPath,'utf8'));delete metadata.run.workspaceFormat;delete metadata.run.workspaceHash;
  await fs.writeFile(metadataPath,JSON.stringify(metadata));await fs.rm(manager.workspace(run.id),{recursive:true});
  const reopened=new ProjectManager(root),migrated=await reopened.read(run.id);
  assert.equal(migrated.workspaceFormat,1);assert.equal(await fs.readFile(path.join(reopened.workspace(run.id),'src','main.js'),'utf8'),'old');
  await fs.writeFile(path.join(reopened.workspace(run.id),'src','main.js'),'new');
  const changed=await reopened.read(run.id);assert.equal(changed.revision,migrated.revision+1);assert.equal(changed.lastCheck,null);
  assert.equal(Buffer.from(unzipSync(await reopened.zip(run.id))['src/main.js']).toString(),'new');
  assert.equal((await new ProjectManager(root).source(run.id))[0].content,'new');
  await fs.rm(path.join(reopened.dir(run.id),'project.zip'));
  assert.equal((await reopened.source(run.id))[0].content,'new');
  assert.equal(Buffer.from(unzipSync(await reopened.zip(run.id))['src/main.js']).toString(),'new');
  const binary=Buffer.from([0,255,42]);await fs.writeFile(path.join(reopened.workspace(run.id),'src','main.js'),binary);
  assert.equal((await reopened.source(run.id))[0].encoding,'base64');
  assert.deepEqual(Buffer.from(unzipSync(await reopened.zip(run.id))['src/main.js']),binary);
});
test('runtime writes are reconciled after execution and task transcripts remain separate',async t=>{
  const {manager,run,cmd}=await setup(t);await manager.save(run.id,[{path:'main.py',content:'old'}],0);
  const task=await cmd('START_TASK',{request:'Change the project'},{chatId:'chat-a'});
  manager.executing.add(run.id);await fs.writeFile(path.join(manager.workspace(run.id),'main.py'),'new');
  await manager.event(run.id,{stage:'Command',text:'python main.py\nExit: 0',taskId:task.id});
  assert.equal((await manager.source(run.id))[0].content,'old');
  manager.executing.delete(run.id);
  const changed=await manager.read(run.id);assert.equal(changed.revision,2);assert.equal((await manager.source(run.id))[0].content,'new');
  assert.equal(changed.tasks[0].events[0].stage,'Command');
  await cmd('FINISH_TASK',{status:'incomplete'},{taskId:task.id});
  const next=await cmd('START_TASK',{request:'Another task'},{chatId:'chat-b'});
  await manager.event(run.id,{stage:'Planning',text:'Inspect first',taskId:next.id});
  const tasks=(await manager.read(run.id)).tasks;assert.deepEqual(tasks.map(item=>item.events.map(event=>event.stage)),[['Command'],['Planning']]);
});
test('completion requires behavior evidence tied to the exact current source',async()=>{
  const {completionStatus}=require('./execution.cjs');const run={sourceHash:'current',lastCheck:{passed:true,sourceHash:'current'}};
  assert.equal(completionStatus(run),'incomplete');run.lastCheck.behaviorVerified=true;assert.equal(completionStatus(run),'checked');run.lastCheck.sourceHash='old';assert.equal(completionStatus(run),'incomplete');
});
test('snapshots stay usable after more than 20 tasks and command settings persist',async t=>{
  const {manager,run,cmd,root}=await setup(t);await manager.save(run.id,[{path:'index.html',content:'<h1>safe</h1>'}],0);
  for(let i=0;i<22;i++)await cmd('CHECKPOINT',{label:'Checkpoint '+i});
  assert.equal((await manager.read(run.id)).checkpoints.length,20);const snapshots=await fs.readdir(path.join(manager.dir(run.id),'checkpoints'));assert.equal(snapshots.filter(name=>name.endsWith('.json')).length,20);assert.equal(snapshots.filter(name=>name.endsWith('.zip')).length,20);
  await cmd('SET_COMMANDS',{baseRevision:1,commands:{test:['npm','run','test']}});
  assert.deepEqual((await new ProjectManager(root).read(run.id)).commands.test,['npm','run','test']);
  const cp=await cmd('CHECKPOINT',{label:'Commands configured'});
  await cmd('SET_COMMANDS',{baseRevision:2,commands:{test:['node','other.js']}});
  await cmd('ROLLBACK',{baseRevision:3,checkpointId:cp.id});
  assert.deepEqual((await manager.read(run.id)).commands.test,['npm','run','test']);
  await assert.rejects(cmd('SET_COMMANDS',{baseRevision:4,commands:{run:['powershell','-Command','x']}}),/finite/);
});
