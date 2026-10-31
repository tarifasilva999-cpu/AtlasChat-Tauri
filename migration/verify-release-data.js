window.__atlasValidation={checks:[],started:Date.now()};
(async()=>{
 await window.atlasMigrationReady;
 const expected=await __TAURI__.core.invoke('atlas_call',{name:'migrationRead'}),chats=JSON.parse(localStorage.getItem('apex.chats.v1'));
 if(localStorage.getItem('atlas.tauri.migration.v1')!=='complete')throw Error('Migration not complete');
 for(const original of JSON.parse(expected.storage['apex.chats.v1']).chats){const actual=chats.chats.find(chat=>chat.id===original.id);if(!actual||JSON.stringify(actual.messages)!==JSON.stringify(original.messages))throw Error('Restored messages differ');}
 const count=await new Promise((resolve,reject)=>{const r=indexedDB.open('atlas-poem3-images-v1',1);r.onsuccess=()=>{const db=r.result,q=db.transaction('images').objectStore('images').count();q.onsuccess=()=>{resolve(q.result);db.close()};q.onerror=()=>reject(q.error)};r.onerror=()=>reject(r.error)});
 if(count!==expected.images.length)throw Error('Saved images changed');
 const projects=await atlasDesktop.projects();
 const before=document.documentElement.dataset.theme,button=document.querySelector('#headerTheme');
 button.click();const after=document.documentElement.dataset.theme;if(before===after)throw Error('Appearance button did not work');
 localStorage.setItem('atlas.tauri.validation.theme',after);
 window.__atlasValidation.checks.push({name:'Real profile restored and UI appearance persists',passed:true,detail:{chats:chats.chats.length,images:count,projects:projects.length,theme:after}});
 window.__atlasValidation.done=true;
})().catch(error=>{window.__atlasValidation.error=String(error.stack||error);window.__atlasValidation.done=true});
