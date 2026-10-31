'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
  const root=path.resolve(__dirname,'../migration-data');
  const meta=JSON.parse(await fs.readFile(path.join(root,'source.json'),'utf8'));
  const data=JSON.parse(await fs.readFile(path.join(root,'electron-cache-export.json'),'utf8'));
  const physical=[];
  async function scan(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await scan(file);else if(!entry.isSymbolicLink()&&/^\d+$/.test(entry.name)){const stat=await fs.stat(file),fd=await fs.open(file,'r'),head=Buffer.alloc(Math.min(stat.size,65536));try{await fd.read(head,0,head.length,0)}finally{await fd.close()}physical.push({file,size:stat.size,head:crypto.createHash('sha256').update(head).digest('hex')});}}}
  await scan(path.join(meta.legacy,'File System'));
  const base='https://huggingface.co/radames/flux2-klein-edge-web/resolve/main/';
  const upstream=[];
  for(const dir of ['web_weights','te_onnx','vae_onnx/r320']){
    const response=await fetch('https://huggingface.co/api/models/radames/flux2-klein-edge-web/tree/main/'+dir);if(!response.ok)throw Error('Cannot validate Poem cache metadata');upstream.push(...await response.json());
  }
  const key=url=>url.replace(/[^a-z0-9._-]+/gi,'_').slice(-180),map={};
  for(const item of data.cache){
    const matches=physical.filter(file=>file.size===item.size&&file.head===item.head);if(matches.length!==1)throw Error('Ambiguous Poem cache file');
    const file=matches[0],hash=crypto.createHash('sha256');for await(const chunk of require('node:fs').createReadStream(file.file))hash.update(chunk);const sha256=hash.digest('hex');
    const origin=upstream.find(file=>key(base+file.path)===item.key);if(!origin)throw Error('Missing upstream cache identity');
    // HF now returns Xet ETags; those are NOT file SHA-256 values. Validate against
    // the LFS content hash, and keep the original ETag separately for freshness.
    if(origin.lfs?.oid&&origin.lfs.oid!==sha256)throw Error('Poem content hash failed: '+origin.path);
    if(!origin.lfs){const content=await fs.readFile(file.file);const git=crypto.createHash('sha1').update(Buffer.from('blob '+content.length+'\0')).update(content).digest('hex');if(git!==origin.oid)throw Error('Poem manifest hash failed');}
    map[item.key]={path:file.file,size:item.size,mtimeMs:(await fs.stat(file.file)).mtimeMs,sha256,etag:item.etag};
  }
  await fs.writeFile(path.join(root,'poem-cache-map.json'),JSON.stringify(map,null,2),{flag:'wx'});
  console.log('Verified read-only Poem cache mappings: '+Object.keys(map).length);
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
