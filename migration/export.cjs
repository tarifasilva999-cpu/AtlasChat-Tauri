'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
async function main() {
  const legacy = process.env.ATLAS_LEGACY_PROFILE || path.join(process.env.APPDATA, 'atlas-desktop');
  const output = path.join(ROOT, 'migration-data');
  await fs.mkdir(output, { recursive: true });
  const cacheOnly=process.argv.includes('--cache');
  const final = path.join(output, cacheOnly?'electron-cache-export.json':'electron-export.json');
  try { await fs.access(final); throw new Error('An export already exists. Preserve it before making a new export.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const snapshot = path.join(output, 'electron-snapshot-' + crypto.randomUUID());
  await fs.mkdir(snapshot);
  for (const name of ['Local Storage', 'IndexedDB', 'Local State']) {
    try { await fs.cp(path.join(legacy, name), path.join(snapshot, name), { recursive: true, errorOnExist: true, force: false }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if(cacheOnly){
    // Only this read-only exporter opens these links. Browser metadata is copied;
    // no model loader, writer, fetch, createWritable or sync write handle is run.
    const copyMetadata=async(src,dst)=>{await fs.mkdir(dst,{recursive:true});for(const entry of await fs.readdir(src,{withFileTypes:true})){const a=path.join(src,entry.name),b=path.join(dst,entry.name);if(entry.isSymbolicLink())throw Error('Unexpected profile link');if(entry.isDirectory())await copyMetadata(a,b);else if((await fs.stat(a)).size>1024*1024)await fs.link(a,b);else await fs.copyFile(a,b);}};
    await copyMetadata(path.join(legacy,'File System'),path.join(snapshot,'File System'));
  }
  await fs.writeFile(path.join(output, 'source.json'), JSON.stringify({ legacy, snapshot, exportedAt: new Date().toISOString() }, null, 2));
  const electron = process.env.ATLAS_EXPORT_ELECTRON || path.resolve(ROOT, '../Atlas/node_modules/electron/dist/electron.exe');
  const code = await new Promise((resolve, reject) => {
    const env = { ...process.env, ATLAS_EXPORT_OUTPUT: final, ATLAS_EXPORT_SNAPSHOT: snapshot, ATLAS_EXPORT_CACHE:cacheOnly?'1':'' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [path.join(__dirname, 'electron-reader.cjs'), '--user-data-dir=' + snapshot], {
      windowsHide: true, stdio: 'inherit', env
    });
    child.once('error', reject); child.once('exit', resolve);
  });
  if (code !== 0) throw new Error('Disposable Electron export failed: ' + code);
  const data = JSON.parse(await fs.readFile(final, 'utf8'));
  if (data.format !== 'AtlasElectronMigration' || !data.storage || !Array.isArray(data.images)) throw new Error('Export validation failed.');
  console.log('Validated Electron export saved locally. Keys: ' + Object.keys(data.storage).length + ', images: ' + data.images.length);
  if(cacheOnly){
    const status=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(__dirname,'map-poem.cjs')],{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',resolve)});
    if(status!==0)throw Error('Poem cache mapping failed. The browser export is preserved.');
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
