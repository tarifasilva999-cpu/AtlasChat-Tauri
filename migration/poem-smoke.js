window.__atlasValidation={checks:[],started:Date.now(),phase:'Preparing Poem offline'};
(async()=>{
 await window.atlasMigrationReady;
 await atlasDesktop.inferenceUnload({runtimeId:'primary'});
 const report=window.__atlasValidation,realFetch=window.fetch.bind(window),external=[];
 window.fetch=(url,options)=>{const address=new URL(typeof url==='string'?url:url.url,location.href);if(['https:','http:'].includes(address.protocol)&&!['tauri.localhost','ipc.localhost','127.0.0.1','localhost'].includes(address.hostname)){external.push(address.origin+address.pathname);return Promise.reject(Error('Offline validation blocked external fetch'))}return realFetch(url,options)};
 try{
   const start=performance.now();
   const image=await window.AtlasPoem3.generate('A red ceramic cup on a plain white table, soft daylight.',{width:512,height:512,onProgress:event=>{report.phase=String(event.stage||event.type||'Working')}});
   const preview=await window.AtlasPoem3.loadPreview(image.id);
   if(!preview)throw Error('Generated preview was unavailable');
   const decoded=new Image();decoded.src=preview;await decoded.decode();if(decoded.naturalWidth!==512)throw Error('Generated image dimensions changed');
   report.checks.push({name:'Poem 3 offline generation and saved preview',passed:true,detail:{elapsedMs:Math.round(performance.now()-start),externalFetchAttempts:external.length,resultKeys:Object.keys(image)}});
 }catch(error){report.checks.push({name:'Poem 3 offline generation and saved preview',passed:false,error:String(error.stack||error),externalFetchAttempts:external})}
 finally{await window.AtlasPoem3.unload();window.fetch=realFetch}
 report.done=true;report.finished=Date.now();
})().catch(error=>{window.__atlasValidation.error=String(error.stack||error);window.__atlasValidation.done=true});
