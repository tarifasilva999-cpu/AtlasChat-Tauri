window.__atlasValidation={checks:[],started:Date.now()};
(async()=>{
 const report=window.__atlasValidation;
 const check=async(name,action)=>{try{const detail=await action();report.checks.push({name,passed:true,detail})}catch(error){report.checks.push({name,passed:false,error:String(error.message||error)})}};
 const assert=(test,message)=>{if(!test)throw Error(message)};
 await window.atlasMigrationReady;
 await check('Frontend and native bridge',async()=>{assert(window.AtlasCoding&&window.createAtlasNativeAdapter&&document.querySelector('#composer'),'Existing frontend did not initialize');return {bridge:await atlasDesktop.info(),title:document.title,url:location.href}});
 await check('Migrated chats, preferences and images',async()=>{
   const expected=await __TAURI__.core.invoke('atlas_call',{name:'migrationRead'});
   const chats=JSON.parse(localStorage.getItem('apex.chats.v1'));assert(chats.chats.length===JSON.parse(expected.storage['apex.chats.v1']).chats.length,'Chat count changed');
   for(const original of JSON.parse(expected.storage['apex.chats.v1']).chats){const actual=chats.chats.find(chat=>chat.id===original.id);assert(actual&&JSON.stringify(actual.messages)===JSON.stringify(original.messages),'Migrated message history changed');}
   const count=await new Promise((resolve,reject)=>{const r=indexedDB.open('atlas-poem3-images-v1',1);r.onsuccess=()=>{const db=r.result,c=db.transaction('images').objectStore('images').count();c.onsuccess=()=>{resolve(c.result);db.close()};c.onerror=()=>reject(c.error)};r.onerror=()=>reject(r.error)});
   assert(count>=expected.images.length,'Saved images were lost');return {chats:chats.chats.length,images:count,marker:localStorage.getItem('atlas.tauri.migration.v1')};
 });
 await check('WebGPU device and browser primitives',async()=>{const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});assert(adapter,'WebView2 did not provide WebGPU');const device=await adapter.requestDevice();device.destroy();return {features:[...adapter.features],wasm:typeof WebAssembly,workers:typeof Worker,indexedDB:typeof indexedDB,opfs:typeof navigator.storage.getDirectory,isolated:crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer}});
 await check('Read-only Poem cache byte ranges',async()=>{const saved=await __TAURI__.core.invoke('atlas_call',{name:'poemCacheInfo'});assert(saved.keys.length===12,'Expected existing Poem cache files');const response=await fetch(saved.base+encodeURIComponent(saved.keys[0]),{headers:{Range:'bytes=0-63'}});assert(response.status===206&&(await response.arrayBuffer()).byteLength===64,'Range read failed');const invalid=await fetch(saved.base+'..%2F..%2Fsecret');assert(!invalid.ok,'Unexpected cache access');return {files:saved.keys.length}});
 await check('Projects accessible',async()=>{const projects=await atlasDesktop.projects();assert(projects.length>=1,'Existing Project missing');const project=await atlasDesktop.read(projects[0].id);return {count:projects.length,revision:project.revision}});
 await check('Project WebView2 preview, behavior assertions and screenshot',async()=>{
   const project=await atlasDesktop.create({title:'Migration browser fixture',runtime:'web',entrypoint:'index.html'});
   try{
     await atlasDesktop.save({id:project.id,baseRevision:0,files:[{path:'index.html',content:'<!doctype html><html><head><title>Fixture</title></head><body><button id="counter" onclick="this.textContent=\'1\'">0</button></body></html>'},{path:'project.tests.json',content:JSON.stringify({tests:[{name:'Counter works',steps:[{action:'click',selector:'#counter'},{action:'assert',selector:'#counter',property:'text',equals:'1'}]}]})}]});
     const result=await atlasDesktop.check(project.id);assert(result.passed&&result.behaviorVerified,JSON.stringify(result));
     const current=await atlasDesktop.read(project.id);
     await atlasDesktop.save({id:project.id,baseRevision:current.revision,files:[{path:'index.html',content:'<!doctype html><html><head><title>Broken fixture</title></head><body><p id="target">Loaded</p><script>throw Error("Intentional migration runtime check")</script></body></html>'},{path:'project.tests.json',content:JSON.stringify({tests:[{name:'Page exists',steps:[{action:'assert',selector:'#target',property:'text',equals:'Loaded'}]}]})}]});
     const broken=await atlasDesktop.check(project.id);assert(!broken.passed&&broken.checks.some(c=>c.consoleErrors?.length),'Project runtime errors were not detected');
     return {passed:true,detectsRuntimeErrors:true,checks:result.checks.map(c=>({command:c.command,exitCode:c.exitCode}))};
   }finally{await atlasDesktop.deleteProject(project.id)}
 });
 await check('Native command allowlist',async()=>{let blocked=false;try{await __TAURI__.core.invoke('atlas_call',{name:'exec',value:{command:'anything'}})}catch{blocked=true}assert(blocked,'Unknown native command was accepted');return {blocked}});
 await check('InlineUI opaque-origin sandbox',async()=>{const host=document.createElement('div');document.body.append(host);window.AtlasInlineUI.render(host,'<section><h3>Migration check</h3><p>Local visual</p><script>parent.atlasDesktop.windowAction("close")</script></section>',{complete:true});const frame=host.querySelector('iframe');assert(frame&&frame.getAttribute('sandbox')==='allow-scripts','InlineUI sandbox missing');assert(!frame.srcdoc.includes('parent.atlasDesktop'),'Model script survived sanitization');assert(frame.contentDocument===null,'InlineUI has same-origin access');host.remove();return {opaque:true}});
 localStorage.setItem('atlas.tauri.validation.persist','saved');
 report.done=true;report.finished=Date.now();
})().catch(error=>{window.__atlasValidation.error=String(error.stack||error);window.__atlasValidation.done=true});
