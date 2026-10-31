'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {runId}=require('./core.cjs');
const {text}=require('./project-audit.cjs');
const {runBrowserTests}=require('./browser-tests.cjs');
async function scopedRead(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0')) throw new Error('Invalid path');
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes(':'))) throw new Error('Invalid path');
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Links cannot be opened.');
  }
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('File unavailable.');
  return fs.readFile(target);
}
function createPreview({store,session,BrowserWindow,previews,MIME}) {
async function preview(id, visible = false) {
  runId(id);
  const run = await store.read(id);
  if (run.runtime !== 'web') throw new Error('Preview is available for web projects.');
  let entry = run.entrypoint;
  const root = path.join(store.dir(id), 'work');
  try { await scopedRead(root, 'dist/index.html'); entry = 'dist/index.html'; } catch {}
  if (!/\.html?$/.test(entry)) throw new Error('No HTML preview entrypoint.');
  await scopedRead(root, entry);
  const partition = 'preview-' + id + '-' + crypto.randomUUID();
  const sandboxSession = session.fromPartition(partition);
  const base = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  const networkErrors = [];
  sandboxSession.protocol.handle('atlas-preview', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== id) return new Response('', { status: 403 });
      let relative = decodeURIComponent(url.pathname.slice(1)) || entry;
      // Serve built assets with absolute /assets paths relative to the build directory.
      if (base && !relative.startsWith(base)) relative = base + relative;
      return new Response(await scopedRead(root, relative), { headers: {
        'Content-Type': MIME[path.extname(relative)] || 'application/octet-stream',
        'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'"
      } });
    } catch { if(new URL(request.url).pathname==='/favicon.ico')return new Response(null,{status:204});networkErrors.push(request.url + ' 404'); return new Response('File unavailable', { status: 404 }); }
  });
  sandboxSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  sandboxSession.webRequest.onBeforeRequest((details, callback) => {
    const blocked = !details.url.startsWith('atlas-preview://' + id + '/') && !details.url.startsWith('data:') && !details.url.startsWith('blob:');
    if (blocked) networkErrors.push(details.url.slice(0,1000) + ' blocked'); callback({cancel:blocked});
  });
  const window = new BrowserWindow({ width: 1050, height: 750, show: visible, title: run.title,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, partition } });
  previews.get(id)?.close(); previews.set(id, window);
  window.once('closed',()=>{if(previews.get(id)!==window)return;previews.delete(id);if(visible)fs.rm(root,{recursive:true,force:true}).catch(()=>{});});
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  const errors = [];
  const previewTimer = visible ? null : setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, 30000);
  window.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(String(event.message).slice(0, 1000));
  });
  window.webContents.debugger.attach('1.3');
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(String(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Uncaught exception').slice(0,1000));
  });
  try {
    const loading=window.loadURL('atlas-preview://' + id + '/' + entry);
    await window.webContents.debugger.sendCommand('Runtime.enable');
    await loading;
    await new Promise(resolve => setTimeout(resolve, 1800));
    if (window.isDestroyed()) throw new Error('Preview stopped.');
    const source = await store.source(id), testFile = source.find(f => f.path === 'project.tests.json');
    let behavior = {passed:false,tests:[],reason:'Add project.tests.json with asserted behavior checks before completion.'};
    if (testFile && !visible) {
      try { behavior = await runBrowserTests(window.webContents, JSON.parse(text(testFile))); }
      catch (e) { behavior = {...behavior,reason:e.message}; }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    const description = await window.webContents.executeJavaScriptInIsolatedWorld(999,[{code:'({title:document.title,text:document.body.innerText.slice(0,800)})'}]);
    const assetErrors=await window.webContents.executeJavaScriptInIsolatedWorld(999,[{code:'Array.from(document.images).filter(img=>!img.complete||img.naturalWidth===0).map(img=>img.getAttribute("src")+" failed image decoding or loading")'}]);
    networkErrors.push(...assetErrors);
    const passed = !errors.length && !networkErrors.length && (visible || behavior.passed);
    const capture = await window.webContents.capturePage();
    await fs.writeFile(path.join(store.dir(id),'preview.png'),capture.toPNG());
    return { command: 'Browser behavior check: ' + entry, executed: true, exitCode: passed ? 0 : 1, behaviorVerified: behavior.passed,
      consoleErrors:errors.slice(0,20),networkErrors:networkErrors.slice(0,20),
      output:JSON.stringify({description,behavior,consoleErrors:errors.slice(0,12),networkErrors:networkErrors.slice(0,12)}).slice(0,8000) };
  } finally {
    if(previewTimer)clearTimeout(previewTimer);
    if (!window.isDestroyed() && window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    if (!visible && !window.isDestroyed()) window.close();
    if (!visible) previews.delete(id);
  }
}
return preview;
}
module.exports={createPreview,scopedRead};
