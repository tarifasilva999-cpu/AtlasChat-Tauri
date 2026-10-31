'use strict';
const {app,ipcMain}=require('electron'),fs=require('node:fs/promises'),path=require('node:path');
const started=Date.now();
const profile=process.env.ATLAS_BASELINE_PROFILE;
if(!profile||!path.resolve(profile).startsWith(path.resolve(__dirname,'../migration-data')+path.sep))throw Error('Disposable baseline profile required');
app.setPath('userData',profile);
// Compare desktop shells with the same UI/data and no loaded model in either.
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(name,fn)=>handle(name,name==='atlas:inferenceLoad'?()=>new Promise(()=>{}):fn);
app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',()=>{
 window.show();
 void fs.writeFile(path.join(profile,'startup.json'),JSON.stringify({processToDocumentMs:Date.now()-started}));
}));
require(path.resolve(__dirname,'../../Atlas/desktop/main.cjs'));
