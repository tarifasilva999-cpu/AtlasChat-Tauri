'use strict';
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
protocol.registerSchemesAsPrivileged([{ scheme: 'atlas', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const snapshot = process.env.ATLAS_EXPORT_SNAPSHOT;
if (!snapshot || !path.resolve(snapshot).startsWith(path.resolve(__dirname, '../migration-data') + path.sep)) throw new Error('Exporter requires a disposable migration snapshot.');
app.setPath('userData', snapshot);
app.whenReady().then(async () => {
  protocol.handle('atlas', () => new Response('<!doctype html><title>Atlas data export</title>'));
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true } });
  await win.loadURL('atlas://app/Atlas-CHAT.html');
  const data = await win.webContents.executeJavaScript(`(async()=>{
    const storage={};
    for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(/^(apex|atlas)[.-]/.test(key))storage[key]=localStorage.getItem(key);}
    const images=[];
    const databases=await indexedDB.databases();
    if(databases.some(d=>d.name==='atlas-poem3-images-v1')){
      const db=await new Promise((res,rej)=>{const r=indexedDB.open('atlas-poem3-images-v1');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
      if(db.objectStoreNames.contains('images')){
        const entries=await new Promise((res,rej)=>{const out=[],r=db.transaction('images','readonly').objectStore('images').openCursor();r.onsuccess=()=>{const c=r.result;if(c){out.push([c.key,c.value]);c.continue();}else res(out)};r.onerror=()=>rej(r.error)});
        for(const [id,value]of entries){if(!(value.blob instanceof Blob))throw Error('Invalid saved image');const data=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(value.blob)});images.push({id,created:value.created,data});}
      }db.close();
    }
    const cache=[];
    if(${process.env.ATLAS_EXPORT_CACHE==='1'}){
      const root=await navigator.storage.getDirectory();
      let dir;try{dir=await root.getDirectoryHandle('flux-klein-v1')}catch{}
      if(dir)for await(const [key,handle]of dir.entries()){
        if(handle.kind!=='file'||key.endsWith('.etag')||key.endsWith('.part'))continue;
        let etag;try{etag=await (await (await dir.getFileHandle(key+'.etag')).getFile()).text()}catch{continue}
        const file=await handle.getFile(),first=await file.slice(0,65536).arrayBuffer();
        const digest=await crypto.subtle.digest('SHA-256',first),head=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
        cache.push({key,size:file.size,etag,head});
      }
    }
    return {format:'AtlasElectronMigration',version:1,storage,images,cache};
  })()`);
  const file = process.env.ATLAS_EXPORT_OUTPUT;
  await fs.writeFile(file + '.partial', JSON.stringify(data), { flag: 'wx' });
  await fs.rename(file + '.partial', file);
  win.destroy(); app.quit();
}).catch(e => { console.error(e); app.exit(1); });
