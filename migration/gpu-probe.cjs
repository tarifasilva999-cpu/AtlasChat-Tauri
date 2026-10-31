'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const{NativeInference}=require('../tauri/models.cjs');
async function main(){
 const data=path.resolve(__dirname,'../migration-data/validation-profile'),config=JSON.parse(await fs.readFile(path.join(data,'migration-config.json')));process.env.ATLAS_LEGACY_MODELS=config.legacyModels;
 const logs=[];
 const runtime=new NativeInference({directory:path.join(data,'native-ai'),spawnImpl:(file,args,options)=>{const child=spawn(file,args,options);for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>logs.push(bytes.toString()));return child},fetchImpl:async(url,options)=>{if(!String(url).startsWith('http://127.0.0.1:'))throw Error('Offline probe blocked external request');return fetch(url,options)}});
 try{
  const ready=await runtime.load({id:'gpu-probe',choice:'firefly',contextWindow:4096});
  const reply=await runtime.complete({id:'gpu-probe-reply',lease:ready.lease,messages:[{role:'user',content:'Say hello.'}],max_tokens:16});
  const result={ready,replyProduced:!!reply.text.trim(),offloaded:runtime.server?.offloaded,hardwareLog:logs.join('').split('\n').filter(line=>/vulkan|offload|cuda|device|n_gpu_layers/i.test(line))};
  await fs.writeFile(path.resolve(__dirname,'../migration-data/gpu-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await runtime.unload()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
