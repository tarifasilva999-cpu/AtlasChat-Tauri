'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {ProjectManager}=require('../desktop/projects.cjs');
async function main(){
  const root=path.resolve(__dirname,'..'),source=path.join(root,'migration-data');
  const metadata=JSON.parse(await fs.readFile(path.join(source,'source.json'),'utf8'));
  const target=process.env.ATLAS_TAURI_DATA_DIR||path.join(process.env.APPDATA,'ai.atlas.chat.tauri');
  try{await fs.access(target);throw Error('Target profile already exists. Refusing to replace it.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const staging=target+'.migrating-'+crypto.randomUUID();await fs.mkdir(staging,{recursive:true});
  const exportPath=await fs.access(path.join(source,'electron-cache-export.json')).then(()=>path.join(source,'electron-cache-export.json')).catch(()=>path.join(source,'electron-export.json'));
  const data=JSON.parse(await fs.readFile(exportPath,'utf8'));
  if(data.format!=='AtlasElectronMigration'||data.version!==1||!data.storage||!Array.isArray(data.images))throw Error('Invalid browser export.');
  await fs.copyFile(exportPath,path.join(staging,'electron-export.json'));
  try{await fs.cp(path.join(metadata.legacy,'coding-projects'),path.join(staging,'coding-projects'),{recursive:true,filter:async src=>{if((await fs.lstat(src)).isSymbolicLink())throw Error('Project snapshot contains a link; migration stopped safely.');return !['work','node_modules'].includes(path.basename(src))}});}catch(e){if(e.code!=='ENOENT')throw e;}
  const projects=new ProjectManager(path.join(staging,'coding-projects'));await projects.init();await projects.recover();
  for(const id of await projects.ids())await projects.state(id);
  let poemCache={};try{poemCache=JSON.parse(await fs.readFile(path.join(source,'poem-cache-map.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.writeFile(path.join(staging,'migration-config.json'),JSON.stringify({version:1,legacyModels:path.join(metadata.legacy,'native-ai'),poemCache},null,2));
  await fs.writeFile(path.join(staging,'migration-receipt.json'),JSON.stringify({at:new Date().toISOString(),source:metadata.legacy,projectCount:(await projects.ids()).length,storageKeys:Object.keys(data.storage).length,images:data.images.length,exportSha256:crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')},null,2));
  await fs.rename(staging,target);console.log('Isolated Tauri profile prepared: '+target);
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
