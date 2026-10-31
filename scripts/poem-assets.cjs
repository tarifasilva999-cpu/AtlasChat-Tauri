'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
async function main(){
 const root=path.resolve(__dirname,'../vendor/poem-static'),info=await fetch('https://huggingface.co/api/models/radames/flux2-klein-edge-web').then(r=>r.json());
 const files=['te_onnx/model.onnx','vae_onnx/r320/model.onnx','vae_onnx/r256/model.onnx','vae_onnx/r128/model.onnx','vae_onnx/bn_stats.json'],records=[];
 for(const file of files){const response=await fetch('https://huggingface.co/radames/flux2-klein-edge-web/resolve/'+info.sha+'/'+file);if(!response.ok)throw Error('Cannot fetch existing Poem graph: '+file);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>32*1024*1024)throw Error('Unexpected large graph');const output=path.join(root,file);await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes);records.push({path:file,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
 await fs.writeFile(path.join(root,'provenance.json'),JSON.stringify({repo:'radames/flux2-klein-edge-web',revision:info.sha,files:records},null,2));console.log('Existing Poem graph assets vendored for offline use.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
