'use strict';
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, session, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, files, projectPath, runId, manifest, fingerprint, LIMITS } = require('./core.cjs');
const { Runner } = require('./runner.cjs');
const { ProjectManager, validateFiles, validateCommands, sourceFromZip, POLICIES, LIMITS: PROJECT_LIMITS } = require('./projects.cjs');
const { bytes, text } = require('./project-audit.cjs');
const { createPreview, scopedRead } = require('./preview.cjs');
const {verifyProject,completionStatus}=require('./execution.cjs');
const { NativeInference } = require('./native-inference.cjs');
const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
  { scheme: 'atlas', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'atlas-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
let win, store, runner, preview, inference, inferenceDirectory;
const previews = new Map();
const inferenceRuntimes = new Map();
const cancelled = new Set();
const checking = new Set();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const approve = async (title, detail, action) => {
  const choice = await dialog.showMessageBox(win, { type: 'question', title, message: title, detail,
    buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
  return choice.response === 0;
};
async function publish(id, stage, text) { return store.event(id, { stage, text }); }
function trusted(event) {
  const frame = event.senderFrame;
  if (!win || event.sender !== win.webContents || frame !== event.sender.mainFrame ||
      !/^atlas:\/\/app\/(?:index|Atlas-CHAT)\.html$/.test(frame.url)) throw new Error('Untrusted caller.');
}
function handle(name, fn) {
  ipcMain.handle('atlas:' + name, (event, value) => { trusted(event); return fn(value); });
}
function inferenceFor(value = {}) {
  const runtimeId = value?.runtimeId || 'primary';
  if (runtimeId === 'primary') return inference;
  if (typeof runtimeId !== 'string' || !/^secondary:[\w:.-]{1,120}$/.test(runtimeId)) throw new Error('Invalid local model session.');
  let runtime = inferenceRuntimes.get(runtimeId);
  if (!runtime) {
    runtime = new NativeInference({ directory: inferenceDirectory,
      emit: event => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('atlas:inference-event', { ...event, runtimeId }); } });
    inferenceRuntimes.set(runtimeId, runtime);
  }
  return runtime;
}
function secureWindow(window) {
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}
async function downloadZip(entries, defaultPath, filters) {
  const { zipSync } = require('fflate');
  const choice = await dialog.showSaveDialog(win, { defaultPath, filters });
  if (choice.canceled || !choice.filePath) return false;
  await fs.writeFile(choice.filePath, zipSync(entries, { level: 6 }));
  return true;
}
function researchOrigin() {
  const value = process.env.ATLAS_SEARCH_URL;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Research service must use HTTPS.');
  return url.origin;
}
let searchSession;
const researchJobs = new Map();
async function research(value) {
  const origin = researchOrigin();
  if (!origin) throw new Error('Online research is not configured for this desktop build.');
  runId(value.id);
  const query = String(value.query || '').trim();
  if (!query || query.length > 600) throw new Error('Invalid search query.');
  const controller = new AbortController();
  researchJobs.set(value.id, controller);
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    if (!searchSession || searchSession.expires < Date.now()) {
      const response = await fetch(origin + '/v1/session', { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error('Research service is unavailable.');
      searchSession = await response.json();
    }
    const response = await fetch(origin + '/v1/search', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + searchSession.token },
      body: JSON.stringify({ query }), signal: controller.signal });
    if (!response.ok) throw new Error('Research is unavailable or its usage limit was reached.');
    const data = await response.json();
    return (Array.isArray(data.results) ? data.results : []).slice(0, 5).map(r => ({ title: String(r.title).slice(0, 180),
      url: String(r.url).slice(0, 2048), excerpt: String(r.excerpt).slice(0, 2400) })).filter(r => /^https:\/\//.test(r.url));
  } finally { clearTimeout(timer); researchJobs.delete(value.id); }
}
app.whenReady().then(async () => {
  // The matching app actions live in Atlas's own compact menu.
  Menu.setApplicationMenu(null);
  inferenceDirectory = path.join(app.getPath('userData'), 'native-ai');
  inference = new NativeInference({ directory: inferenceDirectory,
    emit: event => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('atlas:inference-event', { ...event, runtimeId: 'primary' }); } });
  inferenceRuntimes.set('primary', inference);
  store = new ProjectManager(path.join(app.getPath('userData'), 'coding-projects'));
  await store.init(); await store.recover();
  runner = new Runner(store, approve, publish);
  preview=createPreview({store,session,BrowserWindow,previews,MIME});
  protocol.handle('atlas', async request => {
    try {
      const url = new URL(request.url), relative = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
      if (url.hostname !== 'app' || !/^(?:(?:index\.html|Atlas-CHAT\.html|atlas-ui\.css|atlas-coding\.js|atlas-native\.js|atlas-inline-ui\.js|atlas-poem3\.js|atlas-files\.js|atlas-mlc-worker\.js|manifest\.webmanifest)$|fonts\/|icons\/|vendor\/)/.test(relative)) return new Response('', { status: 403 });
      return new Response(await scopedRead(ROOT, relative), { headers: {
        'Content-Type': MIME[path.extname(relative)] || 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://esm.run https://cdn.jsdelivr.net; worker-src 'self' blob:; connect-src 'self' https:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; frame-src 'self' blob:"
      } });
    } catch { return new Response('Unavailable', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  handle('info', () => ({ version: 1, researchConfigured: !!researchOrigin(), platforms: ['python', 'web'] }));
  handle('inferenceInfo', () => inference.info());
  handle('inferenceLoad', value => inferenceFor(value).load(value));
  handle('inferenceComplete', async value => {
    try { return { ok: true, ...await inferenceFor(value).complete(value) }; }
    catch (error) { return { ok: false, message: String(error.message || error), timeout: error.code === 'TIMEOUT' }; }
  });
  handle('inferenceCancel', value => inferenceFor(value).cancel(value));
  handle('inferenceUnload', async value => {
    const runtimeId = value?.runtimeId || 'primary', runtime = inferenceFor(value);
    await runtime.unload(value);
    if (runtimeId !== 'primary' && !runtime.server && !runtime.loading && !runtime.jobs.size) inferenceRuntimes.delete(runtimeId);
    return true;
  });
  handle('windowAction', action => {
    if (!win || win.isDestroyed()) throw new Error('Atlas window is closed.');
    if (action === 'minimize') win.minimize();
    else if (action === 'toggleMaximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    else throw new Error('Unknown window action.');
    return true;
  });
  handle('create', value => store.create(value));
  handle('createScratch', value => store.createScratch(value));
  handle('read', id => store.read(runId(id)));
  handle('source', id => store.source(runId(id)));
  handle('projects', () => store.list());
  handle('deleteProject', async value => {
    const id = runId(value);
    if (checking.has(id)) throw new Error('Wait for project checks to finish before deleting.');
    return store.remove(id);
  });
  handle('projectCommand', async value => {
    const id=runId(value.id);
    const mutations=['WRITE_FILE','CREATE_FILE','PATCH_FILE','DELETE_FILE','MOVE_FILE','RENAME_FILE','CREATE_DIRECTORY','ROLLBACK','SET_MANIFEST','SET_COMMANDS','SET_PROJECT_MEMORY'];
    const commands=value.name==='BATCH'?value.args?.commands || []:[value];
    if(checking.has(id)&&commands.some(c=>mutations.includes(c.name)))throw new Error('Wait for verification to finish before editing.');
    if(['BUILD','RUN','RUN_TESTS','RUN_BROWSER_TEST'].includes(value.name))return execute(id);
    if(value.name==='EXPORT_ZIP')return exportProject(id);
    if(value.name==='SCREENSHOT')return {dataUrl:'data:image/png;base64,'+(await fs.readFile(path.join(store.dir(id),'preview.png'))).toString('base64')};
    return store.command(value);
  });
  handle('importProject', async () => {
    const choice=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Project ZIP',extensions:['zip']}]});
    if(choice.canceled)return null;const stat=await fs.stat(choice.filePaths[0]);if(stat.size>PROJECT_LIMITS.totalBytes)throw new Error('ZIP exceeds 32 MB.');
    return store.importZip(await fs.readFile(choice.filePaths[0]),path.basename(choice.filePaths[0],'.zip'));
  });
  handle('save', value => {
    if (checking.has(value.id)) throw new Error('Wait for the check to finish before changing files.');
    if(!Number.isInteger(value.baseRevision))throw new Error('Workspace writes require a base revision.');
    return store.save(runId(value.id), value.files, value.baseRevision);
  });
  handle('event', value => store.event(runId(value.id), value));
  handle('model', async value => {
    const run = await store.read(runId(value.id)); run.actualModel = String(value.model).slice(0, 160);
    await store.put(run); return run;
  });
  handle('chooseCoder', async value => {
    const fallback = value?.fallback === true;
    const result = await dialog.showMessageBox(win, { type: 'question',
      message: fallback ? 'The Ultra Code model could not load.' : 'Use the Ultra Code model?',
      detail: fallback ? 'Continue with the selected Atlas model?'
        : 'This optional model is a one-time download of about 4.3 GB and needs additional available memory.',
      buttons: fallback ? ['Use current model', 'Cancel'] : ['Load Ultra Code model', 'Use current model', 'Cancel'],
      defaultId: fallback ? 1 : 2, cancelId: fallback ? 1 : 2, noLink: true });
    return fallback ? (result.response === 0 ? 'standard' : 'cancel') : ['coder', 'standard', 'cancel'][result.response];
  });
  const execute=id=>verifyProject({store,runner,preview,checking,cancelled},id);
  handle('check',execute);
  handle('cancel', id => {
    runId(id); cancelled.add(id); runner.cancel(id); researchJobs.get(id)?.abort();
    previews.get(id)?.close(); previews.delete(id); return true;
  });
  handle('finish', async value => {
    const run = await store.read(runId(value.id));
    run.status = completionStatus(run,value.status==='interrupted');
    await store.put(run); return run;
  });
  handle('preview', async value => {
    const id=runId(value);if(checking.has(id))throw new Error('Wait for project checks to finish before opening a preview.');
    await runner.prepareWork(id,await store.source(id));
    try{return await preview(id,true);}catch(error){previews.get(id)?.close();await runner.cleanupWork(id);throw error;}
  });
  async function exportProject(id) {
    const {run,source}=await store.state(runId(id));
    if (!source.length) throw new Error('No files have been completed yet.');
    if(run.status!=='checked'||completionStatus(run)!=='checked'){
      if(!await approve('Export unverified project?', 'This project has not passed current runtime and behavior checks. Export its files as a draft?', 'Export draft'))return false;
    }
    const entries = Object.fromEntries(source.map(f => [projectPath(f.path), bytes(f)]));
    for(const directory of run.directories || [])entries[directory+'/']=new Uint8Array();
    return downloadZip(entries, run.title.replace(/[^a-z0-9_-]+/gi, '-') + '.zip', [{ name: 'ZIP project', extensions: ['zip'] }]);
  }
  handle('exportProject',exportProject);
  handle('exportBackup', async backup => {
    if (!backup || backup.format !== 'AtlasBackup' || !Array.isArray(backup.chats)) throw new Error('Invalid backup.');
    const text = JSON.stringify(backup);
    if (Buffer.byteLength(text) > 20 * 1024 * 1024) throw new Error('Chat backup is too large.');
    const entries = { 'backup.json': Buffer.from(text), 'bundle.json': Buffer.from('{"format":"AtlasBundle","version":3}') };
    let totalBytes=Buffer.byteLength(text);
    const ids = new Set([...await store.ids(), ...backup.chats.map(c=>c.projectId).filter(Boolean),...backup.chats.flatMap(c => (c.messages || []).map(m => m.projectRunId).filter(Boolean))]);
    if (ids.size > 64) throw new Error('Export projects separately when backing up more than 64 projects.');
    for (const id of ids) {
      const snapshot=await store.state(runId(id)),run=snapshot.run;
      entries['projects/' + id + '/run.json'] = Buffer.from(JSON.stringify(run));
      entries['projects/' + id + '/project.zip'] = await store.zip(id);
      for(const checkpoint of run.checkpoints || []){
        const checkpointId=runId(checkpoint.id),checkpointPath=path.join(store.dir(id),'checkpoints',checkpointId);
        let metadata=JSON.parse(await fs.readFile(checkpointPath+'.json','utf8')),archive;
        try{archive=await fs.readFile(checkpointPath+'.zip');}
        catch(error){
          if(error.code!=='ENOENT'||!Array.isArray(metadata.source))throw error;
          const {zipSync}=require('fflate'),files=validateFiles(metadata.source),checkpointEntries=Object.fromEntries(files.map(file=>[file.path,bytes(file)]));
          for(const directory of metadata.directories||[])checkpointEntries[directory+'/']=new Uint8Array();
          archive=zipSync(checkpointEntries,{level:6});metadata.files=files.map(file=>({path:file.path,binary:file.encoding==='base64',bytes:bytes(file).length}));delete metadata.source;
          await fs.writeFile(checkpointPath+'.zip',archive);await fs.writeFile(checkpointPath+'.json',JSON.stringify(metadata));
        }
        entries['projects/'+id+'/checkpoints/'+checkpointId+'.json']=Buffer.from(JSON.stringify(metadata));
        entries['projects/'+id+'/checkpoints/'+checkpointId+'.zip']=archive;
      }
      totalBytes=Object.values(entries).reduce((n,b)=>n+b.length,0);if(totalBytes>50*1024*1024)throw new Error('Backup exceeds 50 MB including checkpoints. Export large Projects separately.');
    }
    return downloadZip(entries, 'Atlas.atlasbundle', [{ name: 'Atlas with projects', extensions: ['atlasbundle'] }]);
  });
  handle('importBackup', async () => {
    if (checking.size) throw new Error('Stop the current project before restoring.');
    const choice = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Atlas bundle', extensions: ['atlasbundle'] }] });
    if (choice.canceled) return null;
    const stat = await fs.stat(choice.filePaths[0]);
    if (stat.size > 50 * 1024 * 1024) throw new Error('Backup exceeds 50 MB.');
    const { unzipSync } = require('fflate'); let total = 0, count = 0;
    const data = unzipSync(await fs.readFile(choice.filePaths[0]), { filter: file => {
      total += file.originalSize; count++;
      if (total > 50 * 1024 * 1024 || file.originalSize > 48 * 1024 * 1024 || count > 1500 ||
          !/^(backup\.json|bundle\.json|projects\/[a-f0-9-]{36}\/(?:(?:run|source)\.json|project\.zip|checkpoints\/[a-f0-9-]{36}\.(?:json|zip)))$/.test(file.name)) throw new Error('Invalid bundle entry or size.');
      return true;
    } });
    const parse = name => JSON.parse(Buffer.from(data[name] || []).toString('utf8'));
    const header = parse('bundle.json'), backup = parse('backup.json');
    if (header.format !== 'AtlasBundle' || ![1,2,3].includes(header.version) || backup.format !== 'AtlasBackup' || !Array.isArray(backup.chats)) throw new Error('Unsupported Atlas bundle.');
    const validated = [];
    for (const name of Object.keys(data).filter(n => n.endsWith('/run.json'))) {
      const id = runId(name.split('/')[1]), original = parse(name), archive=data['projects/'+id+'/project.zip'];
      const source = archive ? sourceFromZip(archive,original.files||[]).source : validateFiles(parse('projects/' + id + '/source.json'));
      validated.push({ id, original, source, info: {title:original.title,runtime:original.runtime,entrypoint:projectPath(original.entrypoint)} });
    }
    const replacements = new Map(), created = [];
    try {
      for (const item of validated) {
        const run = await store.create(item.info); created.push(run.id);
        await store.save(run.id, item.source);
        const restored = await store.read(run.id);
        restored.status = 'restored'; restored.actualModel = String(item.original.actualModel || '').slice(0, 160);
        restored.memory=item.original.memory&&JSON.stringify(item.original.memory).length<=4000?item.original.memory:{};
        restored.architecture=String(item.original.architecture||'').slice(0,3000);
        restored.directories=Array.isArray(item.original.directories)?item.original.directories.slice(0,512).map(projectPath):[];
        for(const cp of (Array.isArray(item.original.checkpoints)?item.original.checkpoints:[]).slice(-20)){
          const cpId=runId(cp.id),name='projects/'+item.id+'/checkpoints/'+cpId+'.json',archiveName='projects/'+item.id+'/checkpoints/'+cpId+'.zip';if(!data[name])continue;
          const saved=parse(name),archive=data[archiveName],source=archive?sourceFromZip(archive,saved.files||[]).source:validateFiles(saved.source||[]);
          const snapshot={files:source.map(file=>({path:file.path,binary:file.encoding==='base64',bytes:bytes(file).length})),architecture:String(saved.architecture||'').slice(0,3000),memory:saved.memory&&JSON.stringify(saved.memory).length<=4000?saved.memory:{},entrypoint:projectPath(saved.entrypoint),runtime:['web','python','godot','unsupported'].includes(saved.runtime)?saved.runtime:'unsupported',directories:(saved.directories||[]).map(projectPath),commandOverrides:validateCommands(saved.commandOverrides||{})};
          await fs.mkdir(path.join(store.dir(run.id),'checkpoints'),{recursive:true});
          const {zipSync}=require('fflate'),checkpointEntries=Object.fromEntries(source.map(file=>[file.path,bytes(file)]));
          for(const directory of snapshot.directories)checkpointEntries[directory+'/']=new Uint8Array();
          const checkpointArchive=archive||zipSync(checkpointEntries,{level:6});
          await fs.writeFile(path.join(store.dir(run.id),'checkpoints',cpId+'.zip'),checkpointArchive);await fs.writeFile(path.join(store.dir(run.id),'checkpoints',cpId+'.json'),JSON.stringify(snapshot));
          restored.checkpoints.push({id:cpId,label:String(cp.label||'Restored checkpoint').slice(0,100),at:Number(cp.at)||0,revision:Number(cp.revision)||0});
        }
        restored.events = [{ at: Date.now(), stage: 'Restored', text: 'Project restored from backup. Run checks again before relying on previous results.', sources: [] }];
        const history = Array.isArray(item.original.events) ? item.original.events.slice(-100).map(event => ({
          at: Number(event.at) || 0, stage: String(event.stage || '').slice(0, 40), text: String(event.text || '').slice(0, LIMITS.output),
          sources: Array.isArray(event.sources) ? event.sources.slice(0, 5).filter(s => /^https:\/\//.test(s.url)).map(s => ({
            title: String(s.title || '').slice(0, 180), url: String(s.url).slice(0, 2048)
          })) : []
        })) : [];
        restored.events = history.concat(restored.events);
        restored.history=(Array.isArray(item.original.history)?item.original.history:[]).slice(-100).map(h=>({at:Number(h.at)||0,revision:Number(h.revision)||0,taskId:String(h.taskId||'').slice(0,100),chatId:String(h.chatId||'').slice(0,100),checkpoint:h.checkpoint&&runId(h.checkpoint),changes:(Array.isArray(h.changes)?h.changes:[]).slice(0,512).map(c=>({path:projectPath(c.path),baseHash:String(c.baseHash||'').slice(0,64),hash:String(c.hash||'').slice(0,64)}))}));
        restored.tasks=(Array.isArray(item.original.tasks)?item.original.tasks:[]).slice(-50).map(t=>({id:runId(t.id),chatId:String(t.chatId||'').slice(0,100),request:String(t.request||'').slice(0,1800),complexity:POLICIES[t.complexity]?t.complexity:'medium',policy:POLICIES[t.complexity]||POLICIES.medium,status:['checked','incomplete','interrupted'].includes(t.status)?t.status:'interrupted',at:Number(t.at)||0,evidence:[],events:(Array.isArray(t.events)?t.events:[]).slice(-80).map(event=>({at:Number(event.at)||0,stage:String(event.stage||'').slice(0,40),text:String(event.text||'').slice(0,4000),sources:[]})),result:t.result?{passed:!!t.result.passed,executed:!!t.result.executed,reason:String(t.result.reason||'').slice(0,500),sourceHash:String(t.result.sourceHash||'').slice(0,64)}:null,metrics:Object.fromEntries(['modelCalls','inputChars','outputChars','contextChars','filesRead','filesChanged','buildAttempts','repairAttempts','researchCalls'].map(k=>[k,Math.max(0,Number(t.metrics?.[k])||0)])),elapsedMs:Number(t.elapsedMs)||0}));
        await store.put(restored); replacements.set(item.id, run.id);
        if(item.original.commandOverrides)await store.command({id:run.id,name:'SET_COMMANDS',args:{baseRevision:restored.revision,commands:item.original.commandOverrides}});
      }
      for (const chat of backup.chats) for (const message of chat.messages || []) {
        if (message.projectRunId) message.projectRunId = replacements.get(message.projectRunId) || null;
      }
      for(const chat of backup.chats)if(chat.projectId)chat.projectId=replacements.get(chat.projectId)||null;
      return backup;
    } catch (error) {
      for (const id of created) await fs.rm(store.dir(id), { recursive: true, force: true });
      throw error;
    }
  });
  handle('research', research);
  win = new BrowserWindow({ width: 1240, height: 850, minWidth: 650, minHeight: 500, title: 'Atlas', icon: path.join(ROOT, 'icons', 'AtlasPC.png'), frame: false, backgroundColor: '#202020',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  secureWindow(win); await win.loadURL('atlas://app/Atlas-CHAT.html');
  const unloadInferenceRuntimes = () => Promise.all([...inferenceRuntimes.values()].map(runtime => runtime.unload().catch(() => {})));
  win.on('closed', () => { void unloadInferenceRuntimes(); });
  win.webContents.on('render-process-gone', () => { void unloadInferenceRuntimes(); });
});
app.on('before-quit', () => { inference?.cancel(); for (const id of runner?.jobs.keys() || []) runner.cancel(id); });
app.on('window-all-closed', () => app.quit());
