'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
let task;
async function start(){
  const config=JSON.parse(await fs.readFile(path.join(process.env.ATLAS_DATA_DIR,'migration-config.json'),'utf8').catch(()=>'{"poemCache":{}}'));
  const map=config.poemCache||{},token=crypto.randomBytes(32).toString('hex');
  const prefix='https_huggingface.co_radames_flux2-klein-edge-web_resolve_main_';
  const allowed={};
  for(const[key,value]of Object.entries(map)){
    if(!key.startsWith(prefix)||typeof value.path!=='string')continue;
    const stat=await fs.stat(value.path).catch(()=>null);
    if(stat?.size===value.size&&stat.mtimeMs===value.mtimeMs)allowed[key]=value;
  }
  const origins=new Set(['http://tauri.localhost','https://tauri.localhost','tauri://localhost']);
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.origin&&!origins.has(req.headers.origin)){res.writeHead(403);res.end();return;}
      if(!['GET','HEAD','OPTIONS'].includes(req.method)){res.writeHead(405);res.end();return;}
      const url=new URL(req.url,'http://localhost'),parts=url.pathname.slice(1).split('/');
      if(parts[0]!==token){res.writeHead(403);res.end();return;}
      if(req.headers.origin)res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
      res.setHeader('Access-Control-Allow-Headers','Range');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,OPTIONS');res.setHeader('Access-Control-Expose-Headers','Content-Length,Content-Range,ETag');
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
      const record=allowed[decodeURIComponent(parts[1]||'')];if(!record){res.writeHead(404);res.end();return;}
      const stat=await fs.stat(record.path);if(stat.size!==record.size||stat.mtimeMs!==record.mtimeMs||await fs.realpath(record.path)!==path.resolve(record.path)){res.writeHead(409);res.end();return;}
      let start=0,end=stat.size-1,status=200;
      if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m)throw Error('Invalid range');start=Number(m[1]);end=m[2]?Number(m[2]):end;status=206;}
      if(start<0||end>=stat.size||end<start){res.writeHead(416);res.end();return;}
      res.setHeader('Content-Type',record.path.endsWith('.json')?'application/json':'application/octet-stream');res.setHeader('Content-Length',end-start+1);res.setHeader('Accept-Ranges','bytes');res.setHeader('ETag','"'+record.sha256+'"');
      if(status===206)res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);
      res.writeHead(status);if(req.method==='HEAD'){res.end();return;}
      const stream=require('node:fs').createReadStream(record.path,{start,end});res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch{if(!res.headersSent)res.writeHead(400);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  server.unref();
  return {base:`http://127.0.0.1:${server.address().port}/${token}/`,keys:Object.keys(allowed)};
}
module.exports={info:()=>task??=(start().catch(error=>{task=null;throw error}))};
