window.__atlasValidation={checks:[],started:Date.now()};
(async()=>{
 await window.atlasMigrationReady;
 const report=window.__atlasValidation,assert=(test,message)=>{if(!test)throw Error(message)};
 await atlasDesktop.inferenceUnload({runtimeId:'primary'});
 await new Promise(resolve=>setTimeout(resolve,500));
 report.ownsInference=true;
 const offProgress=atlasDesktop.onInference(event=>{if(event.type==='phase')report.nativePhase={phase:event.phase,detail:event.detail}});
 class Base {constructor(choice){this.choice=choice;this.generationEpoch=1;this.interrupted=false} async _summarizeContext(){return ''} }
 for(const choice of ['firefly','forge','apex-ultra','ultra-code']){
   const started=performance.now();report.phase='Loading '+choice;
   let adapter;
   try{
     const state={modelChoice:choice,contextPreferences:{},effort:'medium'};
     adapter=window.createAtlasNativeAdapter(Base,{state,choice,runtimeId:'primary',contextWindowForChoice:()=>4096,isPlanCandidate:()=>false,isCodeRequest:()=>false});
     const events=[];adapter.onmessage=({data})=>events.push(data);
     await adapter._load();assert(adapter.engine,'Model initialization failed: '+events.find(e=>e.type==='error')?.message);
     const loaded=performance.now();report.phase='Generating '+choice;
     await adapter._generate({id:'migration-'+choice,messages:[{role:'user',content:'Say hello in one short sentence.'}],maxNewTokens:32});
     const tokens=events.filter(e=>e.type==='token'),done=events.find(e=>e.type==='done');assert(tokens.length&&done?.text?.trim(),'Missing streamed model response');
     const info=await atlasDesktop.inferenceInfo();report.checks.push({name:choice+' real inference',passed:true,detail:{loadMs:Math.round(loaded-started),replyMs:Math.round(performance.now()-loaded),streamChunks:tokens.length,backend:info.ready.backend,context:info.ready.contextWindow,runtime:info.ready.runtime,log:info.lastLog}});
     if(choice==='firefly'){
       report.phase='Testing cancellation';let stopped=false;
       const off=atlasDesktop.onInference(e=>{if(e.id==='migration-cancel'&&e.type==='chunk'&&!stopped){stopped=true;void atlasDesktop.inferenceCancel({id:'migration-cancel',runtimeId:'primary'})}});
       const result=await atlasDesktop.inferenceComplete({id:'migration-cancel',runtimeId:'primary',lease:adapter.nativeMeta.lease,kind:'chat',messages:[{role:'user',content:'Write a long numbered list of 200 animals.'}],max_tokens:1000});off();assert(stopped&&result.stopped,'Generation did not stop');report.checks.push({name:'Cancellation terminates model process',passed:true,detail:{stopped:result.stopped}});
     }
   }catch(error){report.checks.push({name:choice+' real inference',passed:false,error:String(error.stack||error)})}
   finally{await adapter?._dispose();adapter?._detach()}
 }
 offProgress();report.phase='Finished';report.done=true;report.finished=Date.now();
})().catch(error=>{window.__atlasValidation.error=String(error.stack||error);window.__atlasValidation.done=true});
