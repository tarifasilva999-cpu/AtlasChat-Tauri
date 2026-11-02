'use strict';
(() => {
  if (window !== window.top || !window.__TAURI__) return;
  const call = (name,value) => window.__TAURI__.core.invoke('atlas_call',{name,value:value??null});
  const listeners = new Set();
  const connected = window.__TAURI__.event.listen('atlas-inference',event=>{for(const listener of listeners)listener(event.payload)});
  const names = ['info','create','createScratch','inferenceInfo','inferenceLoad','inferenceComplete','inferenceCancel','inferenceUnload','imagePrepare','imageGenerate','imageCancel','read','source','save','event','model','check','cancel','finish','exportProject','preview','exportBackup','importBackup','research','chooseCoder','windowAction','projects','deleteProject','projectCommand','importProject'];
  const bridge = Object.fromEntries(names.map(name=>[name,async value=>{if(name==='inferenceLoad'&&window.__atlasValidationMode&&!window.__atlasValidation?.ownsInference)return new Promise(()=>{});await connected;return call(name,value)}]));
  bridge.onInference = listener => { if(typeof listener!=='function')throw new TypeError('Expected an inference listener');listeners.add(listener);return()=>listeners.delete(listener); };
  Object.defineProperty(window,'atlasDesktop',{value:Object.freeze(bridge),writable:false,configurable:false});
  window.atlasPoemCacheOptions = async module => {
    const saved=await call('poemCacheInfo'),keys=new Set(saved.keys),fallback=module.createCache({dir:'flux-klein-v1'});
    const address=url=>{const key=module.cacheKey(url);return keys.has(key)?saved.base+encodeURIComponent(key):null};
    const originalBase='https://huggingface.co/radames/flux2-klein-edge-web/resolve/main/';
    window.atlasPoemAssetUrl=url=>{
      const relative=String(url).startsWith(originalBase)?String(url).slice(originalBase.length):'';
      return ['te_onnx/model.onnx','vae_onnx/r320/model.onnx','vae_onnx/r256/model.onnx','vae_onnx/r128/model.onnx','vae_onnx/bn_stats.json'].includes(relative)?new URL('./vendor/poem/static/'+relative,location.href).href:url;
    };
    return {cache:{...fallback,
      cachedFetch:async(url,options={})=>{const local=address(url);if(!local)return fallback.cachedFetch(url,options);const r=await fetch(local,{method:options.noData?'HEAD':'GET'});if(!r.ok)throw Error('Saved Poem cache changed. Restart Atlas to check it.');const total=Number(r.headers.get('content-length'));options.onProgress?.(total,total,true);return options.noData?null:r.arrayBuffer()},
      cachedRange:async(url,off,len,options={})=>{const local=address(url);if(!local)return fallback.cachedRange(url,off,len,options);const r=await fetch(local,{headers:{Range:`bytes=${off}-${off+len-1}`}});return r.status===206?r.arrayBuffer():null}
    }};
  };
  const marker='atlas.tauri.migration.v1';
  function imageDatabase() { return new Promise((resolve,reject)=>{const request=indexedDB.open('atlas-poem3-images-v1',1);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('images'))request.result.createObjectStore('images')};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}); }
  window.atlasMigrationReady = (async()=>{
    if(localStorage.getItem(marker)==='complete')return;
    const data=await call('migrationRead');
    if(!data)return;
    if(data.format!=='AtlasElectronMigration'||data.version!==1||!data.storage||!Array.isArray(data.images))throw Error('Electron migration export is invalid.');
    for(const [key,value]of Object.entries(data.storage))if(!/^(apex|atlas)[.-]/.test(key)||typeof value!=='string')throw Error('Invalid migrated preference.');
    if(data.storage['apex.chats.v1']&&!Array.isArray(JSON.parse(data.storage['apex.chats.v1']).chats))throw Error('Invalid migrated chats.');
    const imageIds=new Set(), images=[];
    for(const image of data.images){if(typeof image.id!=='string'||imageIds.has(image.id)||!/^data:image\/(webp|png|jpeg);base64,/i.test(image.data))throw Error('Invalid migrated image.');imageIds.add(image.id);const parts=image.data.split(','),bytes=Uint8Array.from(atob(parts[1]),c=>c.charCodeAt(0)),blob=new Blob([bytes],{type:parts[0].slice(5,-7)});if(blob.size>10*1024*1024)throw Error('Migrated image exceeds size limit.');images.push({...image,blob});}
    const keys=Object.keys(data.storage);
    if(keys.some(key=>localStorage.getItem(key)!==null)&&localStorage.getItem(marker)!=='pending')throw Error('Tauri already has data. Use the existing backup restore action to merge or replace it explicitly.');
    const before=Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)]));
    localStorage.setItem(marker,'pending');
    let db;
    try{
      db=await imageDatabase();
      await new Promise((resolve,reject)=>{const tx=db.transaction('images','readwrite'),store=tx.objectStore('images');for(const image of images)store.put({blob:image.blob,created:image.created},image.id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});
      for(const [key,value]of Object.entries(data.storage))localStorage.setItem(key,value);
      for(const [key,value]of Object.entries(data.storage))if(localStorage.getItem(key)!==value)throw Error('Migrated preference verification failed.');
      localStorage.setItem(marker,'complete');
    }catch(error){for(const [key,value]of Object.entries(before)){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value)}throw error}
    finally{db?.close()}
  })().catch(error=>{
    console.error('Atlas data migration stopped',error);
    const box=document.createElement('div');box.style.cssText='position:fixed;inset:20%;z-index:99999;padding:32px;background:#202020;color:#eee;border-radius:18px;font:15px system-ui';
    box.textContent='Atlas could not complete the data migration. Your Electron data is safe. '+error.message+' Close Atlas and see migration-data and MIGRATION.md for recovery.';document.body.append(box);
    throw error;
  });
  document.addEventListener('pointerdown',event=>{
    if(event.button===0&&event.target.closest('.rail')&&!event.target.closest('button,a,input,.atlas-actions'))void call('windowAction','startDragging');
  });
})();
