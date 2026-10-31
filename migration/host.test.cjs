'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const{verified}=require('../tauri/models.cjs');
test('legacy model reuse validates bytes and never repairs or writes the legacy directory',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'atlas-legacy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'model.gguf');await fs.writeFile(file,'preserved');const before=await fs.stat(file),hash=crypto.createHash('sha256').update('preserved').digest('hex');
 assert.equal(await verified(root,'model.gguf',9,hash,new AbortController().signal),file);
 assert.equal(await verified(root,'model.gguf',9,'0'.repeat(64),new AbortController().signal),null);
 assert.equal(await verified(root,'../escape',9,hash,new AbortController().signal),null);
 assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);assert.deepEqual(await fs.readdir(root),['model.gguf']);
});
test('Tauri frontend assets retain styling and exclude legacy native entry points',async()=>{
 const root=path.resolve(__dirname,'..'),original=await fs.readFile(path.join(root,'atlas-ui.css'),'utf8'),staged=await fs.readFile(path.join(root,'frontend-dist/atlas-ui.css'),'utf8');assert.equal(staged,original);
 const capability=JSON.parse(await fs.readFile(path.join(root,'src-tauri/capabilities/main.json')));assert.deepEqual(capability.windows,['main']);assert.ok(!capability.permissions.some(x=>/fs:|shell:|http:/.test(x)));
 for(const name of ['Atlas-CHAT.html','index.html']){const html=await fs.readFile(path.join(root,'frontend-dist',name),'utf8');assert.ok(html.indexOf('tauri-bridge.js')<html.indexOf('atlas-coding.js'));assert.ok(html.indexOf('await window.atlasMigrationReady')<html.indexOf('const CHAT_STORE_KEY'));}
});
