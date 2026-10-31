window.__atlasValidation={checks:[]};
(async()=>{
 await window.atlasMigrationReady;
 const expected=localStorage.getItem('atlas.tauri.validation.theme');
 if(!expected||document.documentElement.dataset.theme!==expected)throw Error('Appearance did not survive restart');
 document.querySelector('#headerTheme').click();
 localStorage.removeItem('atlas.tauri.validation.theme');
 window.__atlasValidation.checks.push({name:'Appearance survives restart and original preference restored',passed:true});window.__atlasValidation.done=true;
})().catch(error=>{window.__atlasValidation.error=String(error.stack||error);window.__atlasValidation.done=true});
