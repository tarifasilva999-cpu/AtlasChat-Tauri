'use strict';
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const pending = new Map(), handlers = new Map(), windows = new Map(), protocols = new Map();
let next = 0, shuttingDown = false;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
console.log = (...args) => console.error(...args);
function native(name, value) {
  const id = ++next;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ type: 'native', id, name, value }); });
}
const app = new EventEmitter();
app.getPath = name => { if (name !== 'userData') throw Error('Unsupported application path'); return process.env.ATLAS_DATA_DIR; };
app.whenReady = () => Promise.resolve();
app.quit = () => { void shutdown(); };
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  app.emit('before-quit');
  try { await Promise.all([require('./models.cjs').unloadAll(), app.cleanup?.()]); } finally { process.exit(0); }
}
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.label = options.webPreferences?.preload ? 'main' : 'preview-' + (++next);
    this.destroyed = false; this.webContents = new EventEmitter();
    this.webContents.isDestroyed = () => this.destroyed;
    this.webContents.send = (_name, value) => send({ type: 'inference', value });
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.executeJavaScriptInIsolatedWorld = (_id, scripts) => native('previewEval', { label: this.label, code: scripts[0].code });
    this.webContents.capturePage = async () => { const data = await native('previewCapture', { label: this.label }); return { toPNG: () => Buffer.from(data, 'base64') }; };
    let attached = false;
    const debug = new EventEmitter();
    debug.attach = () => { attached = true; }; debug.detach = () => { attached = false; }; debug.isAttached = () => attached;
    debug.sendCommand = (method, params) => native('previewCdp', { label: this.label, method, params: params || {} });
    this.webContents.debugger = debug;
    this.webContents.mainFrame = { url: 'atlas://app/Atlas-CHAT.html' };
    windows.set(this.label, this);
  }
  async loadURL(url) {
    if (this.label === 'main') { send({ type: 'ready' }); return; }
    await native('previewOpen', { label: this.label, url, visible: !!this.options.show, title: this.options.title });
  }
  close() { if (this.destroyed) return; this.destroyed = true; windows.delete(this.label); void native('previewClose', { label: this.label }).catch(()=>{}); this.emit('closed'); }
  destroy() { this.close(); }
  isDestroyed() { return this.destroyed; }
}
const protocol = { registerSchemesAsPrivileged() {}, handle: (name, handler) => { protocols.set(name, handler); } };
const session = { defaultSession: { setPermissionRequestHandler() {} }, fromPartition: partition => ({
  protocol:{handle:(name,handler)=>protocols.set(name+':'+partition.slice(8,44),handler)}, setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} }
}) };
const ipcMain = { handle: (name, handler) => { handlers.set(name.slice(6), handler); } };
const dialog = {
  showMessageBox: (_win, options) => native('dialogMessage', options),
  showSaveDialog: (_win, options) => native('dialogSave', options),
  showOpenDialog: (_win, options) => native('dialogOpen', options)
};
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let message;
  try {
    if (line.length > 80 * 1024 ** 2) throw Error('IPC request too large');
    message = JSON.parse(line);
    if (message.type === 'nativeResult') {
      const item = pending.get(message.id); if (!item) return; pending.delete(message.id);
      message.error ? item.reject(Error(message.error)) : item.resolve(message.value); return;
    }
    if (message.type === 'previewEvent') {
      const win = windows.get(message.label); if (!win) return;
      if (message.method === 'closed') { win.destroyed = true; windows.delete(message.label); win.emit('closed'); }
      else if(message.method==='Runtime.consoleAPICalled'&&message.params.type==='error')win.webContents.emit('console-message',{level:'error',message:message.params.args.map(arg=>arg.value||arg.description||'').join(' ')});
      else if(message.method==='Network.loadingFailed')win.webContents.emit('console-message',{level:'error',message:'Preview resource failed: '+message.params.errorText});
      else win.webContents.debugger.emit('message', {}, message.method, message.params);
      return;
    }
    if (message.name === '_shutdown') { await shutdown(); return; }
    if (message.name === 'poemCacheInfo') { send({type:'result',id:message.id,value:await require('./poem-server.cjs').info()}); return; }
    if (message.name === '_previewAsset') {
      const handler = protocols.get('atlas-preview:'+new URL(message.value).hostname); if (!handler) throw Error('Preview unavailable');
      const response = await handler({ url: message.value });
      send({ type: 'result', id: message.id, value: { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()).toString('base64') } }); return;
    }
    const handler = handlers.get(message.name); if (!handler) throw Error('Unknown Atlas operation');
    const win = windows.get('main');
    const value = await handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, message.value);
    send({ type: 'result', id: message.id, value: value ?? null });
  } catch (error) { send({ type: 'result', id: message?.id, error: String(error.message || error) }); }
}).on('close', shutdown);
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
module.exports = { app, BrowserWindow, protocol, ipcMain, dialog, shell: { openExternal: url => native('openExternal', url) }, session, Menu: { setApplicationMenu() {} } };
