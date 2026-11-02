'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const { loadModelInstructions } = require('../desktop/model-instructions.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  const ui = path.join(root, 'frontend-dist'), resources = path.join(root, 'src-tauri/resources');
  await fs.mkdir(ui, { recursive: true });
  const profiles = {};
  for (const choice of ['apex-ultra', 'ultra-code', 'forge']) {
    const profile = await loadModelInstructions(choice);
    profiles[choice] = { id: profile.id, prompt: profile.prompt };
  }
  const instructionBundle = `(() => {\n  const profiles = ${JSON.stringify(profiles)};\n  const get = choice => profiles[choice === 'ultra-code' ? 'ultra-code' : ['forge', 'firefly'].includes(choice) ? 'forge' : 'apex-ultra'];\n  window.AtlasModelInstructions = Object.freeze({ forChoice: choice => get(choice)?.prompt || '' });\n})();\n`;
  await fs.writeFile(path.join(ui, 'atlas-model-instructions.js'), instructionBundle);
  for (const name of ['Atlas-CHAT.html','index.html','atlas-ui.css','atlas-updates.js','atlas-coding.js','atlas-inline-ui.js','atlas-native.js','atlas-poem3.js','atlas-files.js','atlas-mlc-worker.js','manifest.webmanifest','icons','fonts','vendor']) {
    await fs.cp(path.join(root,name),path.join(ui,name),{recursive:true});
  }
  await esbuild.build({entryPoints:[path.join(root,'tauri/updater.js')],outfile:path.join(ui,'tauri-updater.js'),bundle:true,format:'iife',platform:'browser',target:'es2020',minify:true,legalComments:'none'});
  await fs.cp(path.join(root,'tauri/bridge.js'),path.join(ui,'tauri-bridge.js'));
  const coding=path.join(ui,'atlas-coding.js');
  await fs.writeFile(coding,(await fs.readFile(coding,'utf8')).replace('(() => {','(async () => {\n  await window.atlasMigrationReady;'));
  for (const name of ['Atlas-CHAT.html','index.html']) {
    const file=path.join(ui,name); let html=await fs.readFile(file,'utf8');
    html=html.replace('<script src="./atlas-coding.js"></script>', '<script src="./tauri-bridge.js"></script>\n<script src="./tauri-updater.js"></script>\n<script src="./atlas-model-instructions.js"></script>\n<script src="./atlas-coding.js"></script>');
    if(!html.includes('atlas-model-instructions.js'))throw Error('Model instruction profiles were not injected into the frontend.');
    html=html.replace(/<script>\s*\(\(\)\s*=>\s*\{/,'<script>\n(async () => {\n  await window.atlasMigrationReady;');
    // Current entry uses an IIFE, assert the migration gate was inserted.
    if(!html.includes('await window.atlasMigrationReady'))throw Error('Frontend startup shape changed; migration must run before localStorage reads.');
    if(!html.includes('tauri-updater.js'))throw Error('Tauri updater bundle was not injected into the frontend.');
    await fs.writeFile(file,html);
  }
  const poem=path.join(ui,'atlas-poem3.js');
  let poemSource=(await fs.readFile(poem,'utf8')).replace('https://esm.run/flux-klein.js@0.6.0','./vendor/poem/runtime.js');
  poemSource=poemSource.replace('cacheDir: "flux-klein-v1",','cacheDir: "flux-klein-v1",\n          tokenizerUrl: new URL("./vendor/poem/tokenizer/", location.href).href,\n          wasmPaths: new URL("./vendor/poem/ort/", location.href).href,\n          ortUrl: new URL("./vendor/poem/ort/ort.wasm.min.mjs", location.href).href,\n          workerUrl: new URL("./vendor/poem/ort-worker.js", location.href).href,');
  poemSource=poemSource.replace('device,\n          mode:', 'device,\n          ...await window.atlasPoemCacheOptions(module),\n          mode:');
  await fs.writeFile(poem,poemSource);
  const poemDir=path.join(ui,'vendor/poem'); await fs.mkdir(poemDir,{recursive:true});
  await esbuild.build({entryPoints:[path.join(root,'node_modules/flux-klein.js/src/index.js'),path.join(root,'node_modules/flux-klein.js/src/ort-worker.js')],outdir:poemDir,entryNames:'[name]',bundle:true,format:'esm',platform:'browser',splitting:true,external:['onnxruntime-web/wasm'],loader:{'.wasm':'file'},plugins:[{name:'atlas-poem-local-assets',setup(build){build.onLoad({filter:/[\\/]flux-klein\.js[\\/]src[\\/](tokenizer|ort-sessions)\.js$/},async args=>{let source=await fs.readFile(args.path,'utf8');source=source.replace('fetchImpl = fetch,','fetchImpl = (...args) => fetch(globalThis.atlasPoemAssetUrl?.(args[0]) || args[0], args[1]),');source=source.replace('`${root}/${path}/model.onnx`,','(globalThis.atlasPoemAssetUrl?.(`${root}/${path}/model.onnx`) || `${root}/${path}/model.onnx`),');return{contents:source,loader:'js',resolveDir:path.dirname(args.path)}})}}]});
  await fs.rename(path.join(poemDir,'index.js'),path.join(poemDir,'runtime.js'));
  await fs.cp(path.join(root,'node_modules/flux-klein.js/tokenizer'),path.join(poemDir,'tokenizer'),{recursive:true});
  const ort=path.join(poemDir,'ort');
  if(!ort.startsWith(path.join(root,'frontend-dist')+path.sep))throw Error('Unsafe generated asset path');
  await fs.rm(ort,{recursive:true,force:true});await fs.mkdir(ort,{recursive:true});
  for(const name of ['ort.wasm.min.mjs','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])await fs.copyFile(path.join(root,'node_modules/onnxruntime-web/dist',name),path.join(ort,name));
  await fs.cp(path.join(root,'vendor/poem-static'),path.join(poemDir,'static'),{recursive:true});
  const backend=path.join(resources,'backend');
  await fs.mkdir(backend,{recursive:true});
  await fs.cp(path.join(root,'model-instructions'),path.join(backend,'model-instructions'),{recursive:true});
  const backendDesktop=path.join(backend,'desktop');
  if(!backendDesktop.startsWith(path.join(root,'src-tauri/resources')+path.sep))throw Error('Unsafe backend staging path');
  await fs.rm(backendDesktop,{recursive:true,force:true});
  await fs.cp(path.join(root,'desktop'),backendDesktop,{recursive:true,filter:source=>!/(?:\.test\.cjs|\.integration\.cjs|[\\/]fixtures|[\\/]preload\.cjs|[\\/]cli\.cjs)$/.test(source)});
  await fs.cp(path.join(root,'tauri'),path.join(backend,'tauri'),{recursive:true,filter:source=>!source.endsWith('.test.cjs')});
  let mainSource=await fs.readFile(path.join(root,'desktop/main.cjs'),'utf8');
  mainSource=mainSource.replace("require('electron')","require('../tauri/protocol.cjs')").replace("require('./native-inference.cjs')","require('../tauri/models.cjs')");
  mainSource=mainSource.replace('runtime = new NativeInference({ directory: inferenceDirectory,',"if (inferenceRuntimes.size >= 2) throw new Error('Only one secondary model can be loaded.');\n    runtime = new NativeInference({ directory: inferenceDirectory,");
  mainSource=mainSource.replace("app.on('before-quit',", "app.cleanup = () => Promise.all([...runner?.cleanupJobs || []]);\napp.on('before-quit',");
  await fs.writeFile(path.join(backend,'desktop/main.cjs'),mainSource);
  await fs.mkdir(path.join(backend,'node_modules'),{recursive:true});
  await fs.cp(path.join(root,'node_modules/fflate'),path.join(backend,'node_modules/fflate'),{recursive:true});
  await fs.mkdir(path.join(resources,'node'),{recursive:true});
  await fs.copyFile(process.execPath,path.join(resources,'node/node.exe'));
  await fs.copyFile(path.join(root,'icons/AtlasPC.png'),path.join(root,'src-tauri/icons/icon.png'));
  console.log('Existing frontend staged; native backend and Node packaged without Electron.');
}
main().catch(e=>{console.error(e);process.exitCode=1});
