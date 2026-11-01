'use strict';
const {atomicRename}=require('./atomic.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, projectPath, runId, fingerprint } = require('./core.cjs');
const { bytes, text, indexFile, audit } = require('./project-audit.cjs');
const LIMITS = { files: 512, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, context: 6000, output: 3000 };
const POLICIES = {
  small: { calls: 4, repairs: 1, research: 0, context: 4500 },
  medium: { calls: 10, repairs: 2, research: 1, context: 6000 },
  large: { calls: 20, repairs: 3, research: 2, context: 9000 }
};
function complexity(request, count = 0) {
  if (/\b(architecture|major|subsystem|refactor|complete game|full game)\b/i.test(request) || count > 8) return 'large';
  if (/\b(rename|text|color|colour|spacing|css|setting)\b/i.test(request) && !/\b(add|feature|build|create|refactor)\b/i.test(request)) return 'small';
  return 'medium';
}
function validateFiles(value) {
  if (!Array.isArray(value) || value.length > LIMITS.files) throw new Error('Workspace supports up to 512 files.');
  let total = 0; const names = new Set();
  const result = value.map(f => {
    const name = projectPath(f.path), key = name.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate path: ' + name); names.add(key);
    if (typeof f.content !== 'string' || ![undefined, 'utf8', 'base64'].includes(f.encoding)) throw new Error('Use text or base64 file content.');
    if (f.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.content))) throw new Error('Invalid base64.');
    const file = { path: name, content: f.content, ...(f.encoding === 'base64' ? { encoding: 'base64' } : {}) }, size = bytes(file).length;
    total += size;
    if (size > LIMITS.fileBytes || total > LIMITS.totalBytes) throw new Error('Workspace byte limit exceeded.');
    return file;
  });
  for(const file of result){const parts=file.path.split('/');for(let i=1;i<parts.length;i++)if(names.has(parts.slice(0,i).join('/').toLowerCase()))throw new Error('A file path is also used as a directory.');}
  return result;
}
function validateCommands(commands) {
  if(!commands||typeof commands!=='object'||Array.isArray(commands))throw new Error('Commands must be an object of argument arrays.');
  for(const [action,argv] of Object.entries(commands))if(!['build','test','typecheck','run'].includes(action)||!Array.isArray(argv)||!argv.length||argv.length>20||!['node','python','npm'].includes(argv[0])||argv.some(s=>typeof s!=='string'||s.length>500||s.includes('\0')))throw new Error('Use finite node/python/npm argument arrays.');
  return commands;
}
function detect(source) {
  const names = source.map(f => f.path);
  const entry = names.find(n => n === 'index.html') || names.find(n => /(?:^|\/)index\.html$/.test(n)) || names.find(n => n === 'main.py') || names.find(n => n === 'project.godot') || names.find(n => /\.py$/.test(n)) || names.find(n => /\.[cm]?js$/.test(n)) || names[0] || 'index.html';
  return { runtime: /\.html?$/.test(entry) ? 'web' : /\.py$/.test(entry) ? 'python' : entry === 'project.godot' ? 'godot' : /\.[cm]?js$/.test(entry) ? 'web' : 'unsupported', entrypoint: entry };
}
function sourceFromZip(data, metadata = []) {
  if(data.length>LIMITS.totalBytes)throw new Error('ZIP exceeds 32 MB.');
  const {unzipSync}=require('fflate');let total=0,count=0;const seen=new Set(),directories=[];
  const unpacked=unzipSync(data,{filter:file=>{const directory=file.name.endsWith('/'),name=projectPath(directory?file.name.slice(0,-1):file.name);if(seen.has(name.toLowerCase()))throw new Error('Duplicate ZIP path.');seen.add(name.toLowerCase());if(directory)directories.push(name);total+=file.originalSize;count++;if(total>LIMITS.totalBytes||file.originalSize>LIMITS.fileBytes||count>LIMITS.files)throw new Error('ZIP expansion limit exceeded.');return !directory;}});
  const known=new Map(metadata.map(file=>[file.path,file]));
  const source=validateFiles(Object.entries(unpacked).map(([name,data])=>{const buffer=Buffer.from(data),decoded=buffer.toString('utf8'),binary=known.has(name)?known.get(name).binary:buffer.includes(0)||!Buffer.from(decoded).equals(buffer)||/\.(?:png|jpe?g|gif|webp|woff2?|mp3|mp4|wav|wasm|ico)$/i.test(name);return {path:name,content:binary?buffer.toString('base64'):decoded,...(binary?{encoding:'base64'}:{})};}));
  return {source,directories};
}
function commandPlan(source, run) {
  if (run.runtime === 'python') return { build: ['python', '-m', 'compileall', '-q', '.'], test: ['python', '-m', 'unittest', 'discover'], run: ['python', run.entrypoint] };
  if (run.runtime !== 'web') return {};
  const file = source.find(f => f.path === 'package.json'); let pkg = {};
  try { pkg = JSON.parse(text(file || { content: '{}' })); } catch {}
  const result = {};
  for (const name of ['build', 'test', 'typecheck']) if (typeof pkg.scripts?.[name] === 'string') result[name] = ['npm', 'run', name];
  result.run = /\.html?$/.test(run.entrypoint) ? ['browser', run.entrypoint] : ['node', run.entrypoint];
  return result;
}
class ProjectManager extends Store {
  constructor(root) { super(root); this.locks = new Map(); this.indexes = new Map(); this.executing = new Set(); }
  workspace(id) { return path.join(this.dir(id), 'workspace'); }
  async readWorkspace(id, run) {
    const root = this.workspace(id), known = new Map((run.files || []).map(file => [file.path, file]));
    const source = [], directories = [], generated = new Set(['node_modules', '.venv', '.git', '__pycache__']);
    let total = 0;
    const visit = async (dir, prefix = '') => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const relative = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory() && generated.has(entry.name.toLowerCase())) continue;
        if (entry.isDirectory() && ['dist', 'build', 'coverage', '.cache'].includes(entry.name.toLowerCase()) &&
            ![...known.keys()].some(name => name.startsWith(relative + '/')) && !(run.directories || []).some(name => name === relative || name.startsWith(relative + '/'))) continue;
        projectPath(relative);
        if (entry.isSymbolicLink()) throw new Error('Project workspace contains a symbolic link: ' + relative);
        if (entry.isDirectory()) { directories.push(relative); await visit(path.join(dir, entry.name), relative); continue; }
        if (!entry.isFile()) throw new Error('Unsupported project workspace entry: ' + relative);
        const stat = await fs.stat(path.join(dir, entry.name));
        total += stat.size;
        if (stat.size > LIMITS.fileBytes || total > LIMITS.totalBytes || source.length >= LIMITS.files) throw new Error('Workspace size limit exceeded: ' + relative);
        const buffer = await fs.readFile(path.join(dir, entry.name)), decoded = buffer.toString('utf8');
        const binary = !!known.get(relative)?.binary || buffer.includes(0) || !Buffer.from(decoded).equals(buffer) ||
          (!known.has(relative) && /\.(?:png|jpe?g|gif|webp|woff2?|mp3|mp4|wav|wasm|ico)$/i.test(relative));
        source.push({ path: relative, content: binary ? buffer.toString('base64') : decoded, ...(binary ? { encoding: 'base64' } : {}) });
      }
    };
    await visit(root);
    const order = new Map((run.files || []).map((file, index) => [file.path, index]));
    source.sort((a,b) => (order.get(a.path) ?? Infinity) - (order.get(b.path) ?? Infinity) || a.path.localeCompare(b.path));
    const explicit = (run.directories || []).filter(dir => directories.includes(dir));
    for (const dir of directories) if (!source.some(file => file.path.startsWith(dir + '/')) && !explicit.includes(dir)) explicit.push(dir);
    return { source: validateFiles(source), directories: explicit };
  }
  async writeWorkspace(id, state) {
    const root = this.dir(id), target = this.workspace(id), stage = path.join(root, 'workspace.next'), previous = path.join(root, 'workspace.previous');
    await fs.rm(stage, { recursive: true, force: true });
    await fs.mkdir(stage, { recursive: true });
    for (const directory of state.run.directories || []) await fs.mkdir(path.join(stage, projectPath(directory)), { recursive: true });
    for (const file of state.source) {
      const dest = path.join(stage, projectPath(file.path));
      await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, bytes(file));
    }
    await fs.rm(previous, { recursive: true, force: true });
    let moved = false;
    try {
      try { await atomicRename(target, previous); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await atomicRename(stage, target);
    } catch (error) {
      if (moved) await atomicRename(previous, target).catch(() => {});
      throw error;
    }
    await fs.rm(previous, { recursive: true, force: true });
  }
  async locked(id, fn) {
    runId(id); const before = this.locks.get(id) || Promise.resolve();
    const next = before.catch(() => {}).then(fn); this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async state(id) { return this.locked(id, () => this._state(id)); }
  async _state(id) {
    try {
      const saved=JSON.parse(await fs.readFile(path.join(this.dir(id), 'workspace.json'), 'utf8'));
      if(Array.isArray(saved.source)){
        saved.run.archiveHash=null;saved.run.checkpointFormat=2;
        await this.migrateCheckpoints(id,saved.run);await this.commit(id,saved);return saved;
      }
      let source,archiveFailed=false;
      try { const archive=await fs.readFile(path.join(this.dir(id),'project.zip')); source=sourceFromZip(archive,saved.run.files||[]).source; }
      catch(error) { if(saved.run.workspaceFormat!==1 || this.executing.has(id))throw error;archiveFailed=true; }
      if((saved.run.checkpointFormat||0)<2){await this.migrateCheckpoints(id,saved.run);saved.run.checkpointFormat=2;await this.commit(id,{run:saved.run,source});}
      if (saved.run.workspaceFormat === 1) {
        const target=this.workspace(id), previous=path.join(this.dir(id),'workspace.previous');
        try { await fs.access(target); } catch (error) {
          if(error.code!=='ENOENT')throw error;
          try { await fs.rename(previous,target); } catch (restoreError) { if(restoreError.code==='ENOENT')throw new Error('Project workspace is missing. Restore it from an Atlas backup.');throw restoreError; }
        }
        if (!this.executing.has(id)) {
          const disk=await this.readWorkspace(id,saved.run);
          if(archiveFailed){source=disk.source;saved.run.archiveHash=null;}
          const state={run:saved.run,source};
          if (fingerprint(disk.source)!==saved.run.sourceHash || fingerprint(disk.directories)!==fingerprint(saved.run.directories||[])) {
            const oldRevision=saved.run.revision;
            saved.run.directories=disk.directories; await this.replace(state,disk.source,{});
            if (saved.run.revision===oldRevision) {
              saved.run.revision++; saved.run.sourceHash=fingerprint(disk.source); saved.run.lastCheck=null; saved.run.status='incomplete';
              saved.run.files=disk.source.map(f=>({path:f.path,bytes:bytes(f).length,hash:fingerprint(f),binary:f.encoding==='base64'}));
              saved.run.commands={...commandPlan(disk.source,saved.run),...saved.run.commandOverrides}; saved.run.updated=Date.now();
              saved.run.history.push({at:Date.now(),revision:saved.run.revision,taskId:null,chatId:null,changes:[],checkpoint:null});
              saved.run.history=saved.run.history.slice(-100);
            }
            saved.run.workspaceHash=fingerprint({source:disk.source,directories:disk.directories});
            await this.commit(id,state);
          } else if(archiveFailed) await this.commit(id,state);
          source=disk.source;
        }
      } else { await this.commit(id,{run:saved.run,source}); }
      return {run:saved.run,source};
    }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const run = await super.read(id), source = await super.source(id);
      const migrated={run:{...run,version:3,revision:0,directories:[],memory:{},history:[],chats:[],checkpoints:[],tasks:[],checkpointFormat:2},source};
      await this.commit(id,migrated);return migrated;
    }
  }
  async migrateCheckpoints(id,run) {
    for(const checkpoint of run.checkpoints||[]){
      const base=path.join(this.dir(id),'checkpoints',runId(checkpoint.id)),metadataPath=base+'.json';
      let saved;try{saved=JSON.parse(await fs.readFile(metadataPath,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(!Array.isArray(saved.source))continue;
      let archive;try{archive=await fs.readFile(base+'.zip');}catch(error){
        if(error.code!=='ENOENT')throw error;
        const source=validateFiles(saved.source),{zipSync}=require('fflate'),entries=Object.fromEntries(source.map(file=>[file.path,bytes(file)]));
        for(const directory of saved.directories||[])entries[directory+'/']=new Uint8Array();
        archive=zipSync(entries,{level:6});
      }
      const source=validateFiles(saved.source);saved.files=source.map(file=>({path:file.path,binary:file.encoding==='base64',bytes:bytes(file).length}));delete saved.source;
      await fs.writeFile(base+'.zip.tmp',archive);await atomicRename(base+'.zip.tmp',base+'.zip');
      await fs.writeFile(metadataPath+'.tmp',JSON.stringify(saved));await atomicRename(metadataPath+'.tmp',metadataPath);
    }
  }
  async commit(id, state) {
    const archiveHash = fingerprint({source:state.source,directories:state.run.directories||[]});
    if (state.run.workspaceFormat !== 1 || state.run.workspaceHash !== archiveHash) {
      await this.writeWorkspace(id, state);
      state.run.workspaceFormat = 1; state.run.workspaceHash = archiveHash;
    }
    if (state.run.archiveHash !== archiveHash) {
      const {zipSync}=require('fflate');
      const entries=Object.fromEntries(state.source.map(f=>[f.path,bytes(f)]));
      for(const directory of state.run.directories||[])entries[directory+'/']=new Uint8Array();
      const archive=zipSync(entries,{level:6});
      const archivePath=path.join(this.dir(id),'project.zip');
      await fs.writeFile(archivePath+'.tmp',archive);await atomicRename(archivePath+'.tmp',archivePath);
      state.run.archiveHash=archiveHash;
    }
    state.run.version=3;
    const file = path.join(this.dir(id), 'workspace.json');
    await fs.writeFile(file + '.tmp', JSON.stringify({run:state.run})); await atomicRename(file + '.tmp', file);
    await fs.rm(path.join(this.dir(id),'source.json'),{force:true});
  }
  async create(value) {
    const runtime = ['web', 'python', 'godot', 'unsupported'].includes(value.runtime) ? value.runtime : 'unsupported';
    const run = { version: 3, id: crypto.randomUUID(), title: String(value.title || 'New project').slice(0,100), runtime,
      entrypoint: projectPath(value.entrypoint || 'index.html'), status: 'incomplete', actualModel: '', created: Date.now(),
      revision: 0, files: [], directories: [], events: [], lastCheck: null, memory: {}, history: [], chats: [], checkpoints: [], tasks: [], architecture: '', commands: {}, sourceHash:fingerprint([]), archiveHash:null, checkpointFormat:2 };
    await fs.mkdir(this.dir(run.id), { recursive: true }); await this.commit(run.id, { run, source: [] }); return run;
  }
  async read(id) { return (await this.state(id)).run; }
  async source(id) { return (await this.state(id)).source; }
  async put(run) {
    return this.locked(run.id, async () => {
      const state = await this._state(run.id);
      if ((run.revision ?? 0) !== state.run.revision) throw new Error('REVISION_CONFLICT: re-read current project.');
      state.run = run; await this.commit(run.id, state);
    });
  }
  async event(id, event) {
    return this.locked(id, async () => {
      const state = await this._state(id);
      const task=state.run.tasks.find(t=>t.id===event.taskId) || (!event.taskId && state.run.tasks.find(t=>t.status==='working'));
      const item={ at: Date.now(), stage: String(event.stage || '').slice(0,40), text: String(event.text || '').slice(0,16000),
        ...(task?{taskId:task.id,chatId:task.chatId}:{}),
        sources: (Array.isArray(event.sources) ? event.sources : []).slice(0,5).filter(s => /^https:\/\//.test(s.url)).map(s => ({ title: String(s.title).slice(0,180), url: String(s.url).slice(0,2048) })) };
      state.run.events.push(item);
      if(task){task.events=[...(task.events||[]),{...item,text:item.text.slice(0,4000)}].slice(-80);}
      state.run.events = state.run.events.slice(-120); await this.commit(id, state); return state.run;
    });
  }
  async save(id, value, expectedRevision, actor = {}) {
    return this.locked(id, async () => {
      const state = await this._state(id);
      if (expectedRevision !== undefined && expectedRevision !== state.run.revision) throw new Error('REVISION_CONFLICT: workspace changed; re-read before editing.');
      await this.replace(state, validateFiles(value), actor); await this.commit(id, state); return state.run;
    });
  }
  async replace(state, source, actor) {
    const old = new Map(state.source.map(f => [f.path, fingerprint(f)])), next = new Map(source.map(f => [f.path, fingerprint(f)]));
    const changes = [...new Set([...old.keys(), ...next.keys()])].filter(n => old.get(n) !== next.get(n)).map(n => ({ path: n, baseHash: old.get(n) || null, hash: next.get(n) || null }));
    if (!changes.length) return;
    const run = state.run;
    run.revision++; run.sourceHash = fingerprint(source); run.lastCheck = null; run.status = run.tasks.some(t=>t.status==='working')?'working':'incomplete';
    run.files = source.map(f => ({ path: f.path, bytes: bytes(f).length, hash: fingerprint(f), binary: f.encoding === 'base64' }));
    run.commands = {...commandPlan(source, run),...run.commandOverrides}; run.updated = Date.now();
    run.history.push({ at: Date.now(), revision: run.revision, taskId: actor.taskId || null, chatId: actor.chatId || null, changes, checkpoint: run.checkpoints.at(-1)?.id || null });
    run.history = run.history.slice(-100); state.source = source;
    const task = run.tasks.find(t => t.id === actor.taskId); if (task) task.metrics.filesChanged += changes.length;
  }
  index(id, source) {
    const previous = this.indexes.get(id) || {}, names = new Set(source.map(f => f.path)), key = fingerprint([...names]); const result = {};
    for (const file of source) result[file.path] = previous[file.path]?.hash === fingerprint(file) && previous[file.path]?.treeKey === key
      ? previous[file.path] : { ...indexFile(file, names), treeKey: key };
    this.indexes.set(id, result); return result;
  }
  manifest(run, source, index) {
    return { name: run.title, runtime: run.runtime, entrypoint: run.entrypoint, revision: run.revision, architecture: run.architecture,
      commands: run.commands || commandPlan(source, run), files: source.length, knownIssues: run.lastCheck?.reason || '',
      tests: source.filter(f => /(?:^|\/)(?:test|.*\.test)|project\.tests\.json/.test(f.path)).map(f => f.path).slice(0,30),
      importantFiles: Object.entries(index).sort((a,b) => b[1].refs.length - a[1].refs.length).slice(0,8).map(([name]) => name) };
  }
  async command(value) {
    const { id, name, args = {}, chatId, taskId } = value; runId(id);
    if (name === 'BATCH') {
      if (!Array.isArray(args.commands) || args.commands.length > 8 || args.commands.some(c => c.name === 'BATCH')) throw new Error('Batch supports 1–8 commands.');
      const results = []; for (const c of args.commands) results.push(await this.command({ id, chatId, taskId, ...c })); return { results };
    }
    return this.locked(id, async () => {
      const state = await this._state(id), { run, source } = state, index = this.index(id, source);
      const task = run.tasks.find(t => t.id === taskId);
      const limit = Math.max(100, Math.min(Number(args.limit) || LIMITS.output, 12000));
      let result;
      const file = () => { const f = source.find(f => f.path === projectPath(args.path)); if (!f) throw new Error('FILE_MISSING: ' + args.path); return f; };
      const revision = () => { if (args.baseRevision !== run.revision) throw new Error('REVISION_CONFLICT: expected ' + args.baseRevision + ', current ' + run.revision); };
      const mutate = async next => { revision(); await this.replace(state, validateFiles(next), { chatId, taskId }); return { revision: run.revision, sourceHash: run.sourceHash }; };
      const matches = query => Object.entries(index).filter(([n,i]) => (n + ' ' + i.symbols.join(' ')).toLowerCase().includes(String(query).toLowerCase()));
      switch (name) {
        case 'PROJECT_STATUS': result = { id, title: run.title, revision: run.revision, status: run.status, fileCount: source.length, lastCheck: run.lastCheck && { passed: run.lastCheck.passed, reason: run.lastCheck.reason }, task: task && { id: task.id, complexity: task.complexity, policy: task.policy, metrics: task.metrics } }; break;
        case 'LIST_FILES': case 'LIST_DIRECTORY': {const all=run.files.filter(f => !args.path || f.path.startsWith(args.path + '/')),offset=Math.max(0,Number(args.offset)||0);result = { files: all.slice(offset,offset+100), directories: run.directories, total:all.length,nextOffset:all.length>offset+100?offset+100:null };break;}
        case 'READ_FILE': case 'READ_RANGE': {
          const f = file(); if (task) task.metrics.filesRead++;
          if (f.encoding === 'base64') result = { path: f.path, binary: true, bytes: bytes(f).length, hash: fingerprint(f) };
          else { const lines = f.content.split('\n'), start = Math.max(1,Number(args.start) || 1), end = Math.min(lines.length,Number(args.end) || start + 79);
            const content = lines.slice(start-1,end).join('\n'); result = { path: f.path, hash: fingerprint(f), start, end, totalLines: lines.length, content: content.slice(0,limit), truncated: content.length > limit || end < lines.length }; }
          break;
        }
        case 'SEARCH_FILES': case 'FIND_REFERENCES': {
          const query = String(args.query || '').toLowerCase(); if (!query) throw new Error('Search needs a literal query.');
          const found = []; for (const f of source) { let line = 0; for (const s of text(f).split('\n')) { line++; if (s.toLowerCase().includes(query)) { found.push({ path:f.path,line,text:s.slice(0,180) }); if (found.length >= 40) break; } } if (found.length >= 40) break; }
          result = { matches: found, capped: found.length === 40 }; break;
        }
        case 'SEARCH_SYMBOL': result = { matches: matches(args.query).slice(0,30).map(([p,i]) => ({ path:p,symbols:i.symbols.filter(s => s.toLowerCase().includes(String(args.query).toLowerCase())).slice(0,20) })) }; break;
        case 'GET_DEPENDENCIES': result = { path: file().path, dependencies: index[args.path].refs }; break;
        case 'GET_DEPENDENTS': result = { files: Object.entries(index).filter(([,i]) => i.refs.some(r => r.path === args.path)).map(([n]) => n) }; break;
        case 'GET_CHANGED_FILES': case 'GET_RECENT_CHANGES': result = { changes: run.history.slice(-5) }; break;
        case 'GET_PROJECT_MANIFEST': result = this.manifest(run,source,index); break;
        case 'GET_PROJECT_MEMORY': result = run.memory; break;
        case 'SET_PROJECT_MEMORY': {
          revision(); if (JSON.stringify(args.memory).length > 4000 || !args.memory || typeof args.memory !== 'object') throw new Error('Memory must be a compact object.');
          run.memory = args.memory; run.revision++; result = { saved: true, revision:run.revision }; break;
        }
        case 'SET_MANIFEST': {
          revision(); if (args.entrypoint) run.entrypoint = projectPath(args.entrypoint);
          if (args.runtime && !['web','python','godot','unsupported'].includes(args.runtime)) throw new Error('Unsupported runtime adapter.');
          if (args.runtime) run.runtime = args.runtime;
          if (args.architecture !== undefined) run.architecture = String(args.architecture).slice(0,3000);
          run.revision++; run.lastCheck = null; run.status = 'incomplete'; run.commands = commandPlan(source,run); result = { revision:run.revision }; break;
        }
        case 'RENAME_PROJECT': revision();run.title=String(args.title||'Untitled project').slice(0,100);run.revision++;result={revision:run.revision};break;
        case 'SET_COMMANDS': {
          revision(); const commands=validateCommands(args.commands);
          run.commandOverrides=commands;run.commands={...commandPlan(source,run),...commands};run.revision++;run.lastCheck=null;run.status='incomplete';result={revision:run.revision,commands:run.commands};break;
        }
        case 'WRITE_FILE': case 'CREATE_FILE': {
          const p = projectPath(args.path), previous = source.find(f => f.path === p);
          if (name === 'CREATE_FILE' && previous) throw new Error('FILE_EXISTS');
          if (previous && args.baseHash !== fingerprint(previous)) throw new Error('HASH_CONFLICT: read current file before replacing it.');
          result = await mutate(source.filter(f => f.path !== p).concat({ path:p, content:args.content, ...(args.encoding ? {encoding:args.encoding} : {}) })); break;
        }
        case 'PATCH_FILE': {
          const f = file(); if (f.encoding === 'base64') throw new Error('Cannot patch binary files.');
          if (args.baseHash !== fingerprint(f)) throw new Error('HASH_CONFLICT: re-read the file.');
          if (typeof args.search !== 'string' || !args.search || f.content.split(args.search).length !== 2 || typeof args.replace !== 'string') throw new Error('Patch search must match exactly once.');
          result = await mutate(source.map(s => s === f ? {...f,content:f.content.replace(args.search,() => args.replace)} : s)); break;
        }
        case 'DELETE_FILE': { const f = file(); if (args.baseHash !== fingerprint(f)) throw new Error('HASH_CONFLICT'); result = await mutate(source.filter(s => s !== f)); break; }
        case 'MOVE_FILE': case 'RENAME_FILE': { const f=file(), target=projectPath(args.to); if (args.baseHash !== fingerprint(f)) throw new Error('HASH_CONFLICT: re-read the file.'); if (source.some(s => s.path.toLowerCase() === target.toLowerCase())) throw new Error('FILE_EXISTS'); result=await mutate(source.map(s => s===f ? {...f,path:target} : s)); break; }
        case 'CREATE_DIRECTORY': revision(); if(source.some(f=>f.path.toLowerCase()===String(args.path).toLowerCase()))throw new Error('FILE_EXISTS');run.directories = [...new Set([...run.directories, projectPath(args.path)])]; run.revision++; result={revision:run.revision}; break;
        case 'CHECK_SYNTAX': case 'VALIDATE_REFERENCES': case 'VALIDATE_ASSETS': case 'AUDIT': {
          const checked = audit(source,run,index); result={...checked,errors:checked.errors.slice(0,12)}; break;
        }
        case 'SELECT_CONTEXT': {
          const tokens = [...new Set(String(args.request || '').toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [])].filter(t => !['the','and','make','add','with','this','that','project','please'].includes(t));
          const ranked = source.filter(f => f.encoding !== 'base64').map(f => ({ f, score:tokens.reduce((n,t) => n + (f.path.toLowerCase().includes(t)?8:0) + (index[f.path].symbols.some(s => s.toLowerCase().includes(t))?6:0) + (text(f).toLowerCase().includes(t)?2:0),0) + (f.path === run.entrypoint?1:0) })).sort((a,b) => b.score-a.score);
          const selected = ranked.filter(r => r.score > 0).slice(0,3), related = new Set(selected.flatMap(r => index[r.f.path].refs.map(d => d.path)).filter(Boolean));
          for (const p of related) { if (selected.length >= 5) break; const r=ranked.find(r=>r.f.path===p); if(r&&!selected.includes(r)) selected.push(r); }
          let remaining = Math.min(Number(args.budget) || task?.policy.context || LIMITS.context,12000);
          const files = [];
          for (const {f} of selected) { if (remaining < 100) break; const lines=text(f).split('\n'), hit=lines.findIndex(l=>tokens.some(t=>l.toLowerCase().includes(t))), start=Math.max(0,hit-8), content=lines.slice(start,start+70).join('\n').slice(0,remaining); remaining-=content.length;
            files.push({path:f.path,hash:fingerprint(f),start:start+1,content,truncated:content.length<text(f).length}); }
          if(task) {task.metrics.filesRead+=files.length;task.metrics.contextChars+=JSON.stringify(files).length;}
          result={revision:run.revision,manifest:this.manifest(run,source,index),memory:run.memory,files}; break;
        }
        case 'CHECKPOINT': {
          const checkpoint={id:crypto.randomUUID(),at:Date.now(),revision:run.revision,label:String(args.label || 'Checkpoint').slice(0,100)};
          await fs.mkdir(path.join(this.dir(id),'checkpoints'),{recursive:true});
          const {zipSync}=require('fflate'),entries=Object.fromEntries(source.map(f=>[f.path,bytes(f)]));
          for(const directory of run.directories||[])entries[directory+'/']=new Uint8Array();
          await fs.writeFile(path.join(this.dir(id),'checkpoints',checkpoint.id+'.zip'),zipSync(entries,{level:6}));
          await fs.writeFile(path.join(this.dir(id),'checkpoints',checkpoint.id+'.json'),JSON.stringify({files:run.files,architecture:run.architecture,memory:run.memory,entrypoint:run.entrypoint,runtime:run.runtime,directories:run.directories,commandOverrides:run.commandOverrides||{}}));
          run.checkpoints.push(checkpoint);
          // Retain the most recent 20 snapshots; publish metadata before deleting the oldest file.
          const expired=run.checkpoints.length>20?run.checkpoints.shift():null;
          await this.commit(id,state);
          if(expired){await fs.rm(path.join(this.dir(id),'checkpoints',runId(expired.id)+'.json'),{force:true});await fs.rm(path.join(this.dir(id),'checkpoints',runId(expired.id)+'.zip'),{force:true});}
          result=checkpoint;break;
        }
        case 'LIST_CHECKPOINTS': result={checkpoints:run.checkpoints};break;
        case 'DIFF_CHECKPOINT': {
          const checkpoint=run.checkpoints.find(item=>item.id===args.checkpointId);if(!checkpoint)throw new Error('Checkpoint missing.');
          const base=path.join(this.dir(id),'checkpoints',runId(checkpoint.id));
          const saved=JSON.parse(await fs.readFile(base+'.json','utf8'));
          const before=sourceFromZip(await fs.readFile(base+'.zip'),saved.files||[]).source;
          const old=new Map(before.map(item=>[item.path,item])),current=new Map(source.map(item=>[item.path,item]));
          const changed=[...new Set([...old.keys(),...current.keys()])].filter(file=>!old.has(file)||!current.has(file)||fingerprint(old.get(file))!==fingerprint(current.get(file)));
          let remaining=12000;const changes=[];
          for(const file of changed.slice(0,30)){
            const a=old.get(file),b=current.get(file),kind=!a?'Added':!b?'Deleted':'Modified';
            if(a?.encoding==='base64'||b?.encoding==='base64'){changes.push({path:file,kind,binary:true,diff:'Binary file changed.'});continue;}
            const left=a?a.content.split('\n'):[],right=b?b.content.split('\n'):[];let start=0,end=0;
            while(start<left.length&&start<right.length&&left[start]===right[start])start++;
            while(end<left.length-start&&end<right.length-start&&left[left.length-1-end]===right[right.length-1-end])end++;
            const removed=left.slice(start,Math.min(left.length-end,start+40)),added=right.slice(start,Math.min(right.length-end,start+40));
            const lines=['@@ line '+(start+1)+' @@',...removed.map(line=>'- '+line.slice(0,500)),...added.map(line=>'+ '+line.slice(0,500))];
            const raw=lines.join('\n'),allowed=Math.max(0,Math.min(2400,remaining));remaining-=Math.min(raw.length,allowed);
            changes.push({path:file,kind,diff:raw.slice(0,allowed),truncated:raw.length>allowed||left.length-end-start>removed.length||right.length-end-start>added.length||[...removed,...added].some(line=>line.length>500)});
            if(remaining<=0)break;
          }
          result={checkpoint:{id:checkpoint.id,label:checkpoint.label},changes,truncated:changes.length<changed.length};break;
        }
        case 'ROLLBACK': {
          revision(); const checkpoint=run.checkpoints.find(c=>c.id===args.checkpointId);if(!checkpoint)throw new Error('Checkpoint missing.');
          const saved=JSON.parse(await fs.readFile(path.join(this.dir(id),'checkpoints',checkpoint.id+'.json'),'utf8'));
          let checkpointSource;
          try{
            const {unzipSync}=require('fflate'),archived=unzipSync(await fs.readFile(path.join(this.dir(id),'checkpoints',checkpoint.id+'.zip'))),fileMetadata=new Map((saved.files||[]).map(file=>[file.path,file]));
            checkpointSource=Object.entries(archived).filter(([name])=>!name.endsWith('/')).map(([name,data])=>{const meta=fileMetadata.get(name),buffer=Buffer.from(data);return {path:name,content:meta?.binary?buffer.toString('base64'):buffer.toString('utf8'),...(meta?.binary?{encoding:'base64'}:{})};});
          }catch(error){
            if(error.code!=='ENOENT'||!Array.isArray(saved.source))throw error;
            checkpointSource=validateFiles(saved.source);const {zipSync}=require('fflate'),entries=Object.fromEntries(checkpointSource.map(file=>[file.path,bytes(file)]));
            for(const directory of saved.directories||[])entries[directory+'/']=new Uint8Array();
            await fs.writeFile(path.join(this.dir(id),'checkpoints',checkpoint.id+'.zip'),zipSync(entries,{level:6}));
            saved.files=checkpointSource.map(file=>({path:file.path,binary:file.encoding==='base64',bytes:bytes(file).length}));delete saved.source;
            await fs.writeFile(path.join(this.dir(id),'checkpoints',checkpoint.id+'.json'),JSON.stringify(saved));
          }
          saved.source=checkpointSource;
          const before=run.revision; run.architecture=saved.architecture;run.memory=saved.memory;run.entrypoint=saved.entrypoint;run.runtime=saved.runtime;run.directories=saved.directories;
          run.commandOverrides=validateCommands(saved.commandOverrides||{});
          await this.replace(state,validateFiles(saved.source),{chatId,taskId});if(run.revision===before)run.revision++;
          run.lastCheck=null;run.status='incomplete';run.commands={...commandPlan(state.source,run),...run.commandOverrides};result={revision:run.revision};break;
        }
        case 'START_TASK': {
          if(run.tasks.some(t=>t.status==='working'))throw new Error('PROJECT_BUSY: finish the active task first.');
          const level=complexity(String(args.request || ''),Number(args.fileCount)||0),t={id:crypto.randomUUID(),chatId,request:String(args.request||'').slice(0,1800),complexity:level,policy:POLICIES[level],status:'working',at:Date.now(),evidence:[],events:[],metrics:{modelCalls:0,inputChars:0,outputChars:0,contextChars:0,filesRead:0,filesChanged:0,buildAttempts:0,repairAttempts:0,researchCalls:0}};
          run.tasks.push(t);run.tasks=run.tasks.slice(-50);run.status='working';run.lastCheck=null;result=t;break;
        }
        case 'RECORD_CALL': {
          if(!task||task.status!=='working')throw new Error('No active task.');if(task.metrics.modelCalls>=task.policy.calls)throw new Error('MODEL_BUDGET_EXHAUSTED: completed files retained.');
          task.metrics.modelCalls++;task.metrics.inputChars+=Math.max(0,Number(args.inputChars)||0);result={remaining:task.policy.calls-task.metrics.modelCalls};break;
        }
        case 'RECORD_OUTPUT': if(task)task.metrics.outputChars+=Math.max(0,Number(args.chars)||0);result={saved:true};break;
        case 'BUILD_ATTEMPT': if(task)task.metrics.buildAttempts++;result={saved:true};break;
        case 'NEXT_REPAIR': {
          if(!task)throw new Error('No active task.');const evidence=fingerprint(JSON.stringify(args.errors).replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|s)\b/g,'<duration>'));
          const allowed=task.metrics.repairAttempts<task.policy.repairs&&!task.evidence.includes(evidence)&&Boolean(args.errors?.length);
          if(allowed){task.evidence.push(evidence);task.metrics.repairAttempts++;}
          result={allowed,level:Math.min(3,task.metrics.repairAttempts),reason:allowed?'New failure evidence':task.evidence.includes(evidence)?'Repeated failure; automatic repairs stopped.':'Repair budget exhausted.'};break;
        }
        case 'RESEARCH_PERMISSION': {
          if(!task||task.metrics.researchCalls>=task.policy.research||!task.metrics.repairAttempts||!String(args.question||'').trim())result={allowed:false};
          else {task.metrics.researchCalls++;result={allowed:true};}break;
        }
        case 'FINISH_TASK': if(task){task.status=String(args.status||'incomplete');task.elapsedMs=Date.now()-task.at;task.result=run.lastCheck?{passed:!!run.lastCheck.passed,executed:!!run.lastCheck.executed,reason:String(run.lastCheck.reason||'').slice(0,500),sourceHash:run.lastCheck.sourceHash}:null;}result={saved:true};break;
        case 'ATTACH_CHAT': if(typeof chatId!=='string'||chatId.length>100)throw new Error('Invalid chat ID.');run.chats=[...new Set([...run.chats,chatId])];result={chats:run.chats};break;
        case 'DETACH_CHAT': if(typeof chatId!=='string'||chatId.length>100)throw new Error('Invalid chat ID.');run.chats=run.chats.filter(id=>id!==chatId);result={chats:run.chats};break;
        case 'GET_BUILD_OUTPUT': case 'GET_RUNTIME_OUTPUT': case 'GET_CONSOLE_ERRORS': case 'GET_NETWORK_ERRORS': result={checks:(run.lastCheck?.checks||[]).filter(c => name==='GET_BUILD_OUTPUT'||name==='GET_RUNTIME_OUTPUT'||(name==='GET_CONSOLE_ERRORS'?c.consoleErrors?.length:c.networkErrors?.length)).map(c=>({...c,output:String(c.output||'').slice(-limit)})).slice(-8)};break;
        default: throw new Error('Unknown project command: '+name);
      }
      await this.commit(id,state);return result;
    });
  }
  async remove(id) {
    return this.locked(id, async () => {
      const run = (await this._state(id)).run;
      if (run.status === 'working' || run.tasks.some(task => task.status === 'working')) throw new Error('Finish or stop the active project task before deleting.');
      const root = path.resolve(this.root), target = path.resolve(this.dir(id));
      if (path.dirname(target) !== root) throw new Error('Invalid project directory.');
      await fs.rm(target, { recursive: true });
      this.indexes.delete(id);
      return true;
    });
  }
  async list() { const result=[];for(const id of await this.ids()){const r=await this.read(id);result.push({id,title:r.title,status:r.status,revision:r.revision,chats:r.chats,updated:r.updated||r.created});}return result.sort((a,b)=>b.updated-a.updated); }
  async recover() { await super.recover();for(const id of await this.ids())await this.locked(id,async()=>{const s=await this._state(id);for(const t of s.run.tasks)if(t.status==='working')t.status='interrupted';await this.commit(id,s);}); }
  async importZip(data, title) {
    const {source,directories}=sourceFromZip(data);
    if(!source.length)throw new Error('ZIP contains no files.');const run=await this.create({title,...detect(source)});await this.save(run.id,source,0);const imported=await this.read(run.id);imported.directories=directories;await this.put(imported);return this.read(run.id);
  }
  async zip(id) { return this.locked(id,async()=>{await this._state(id);return fs.readFile(path.join(this.dir(id),'project.zip'));}); }
}
module.exports={ProjectManager,validateFiles,validateCommands,detect,complexity,sourceFromZip,POLICIES,LIMITS};
