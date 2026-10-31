'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
async function main(){
 const root=path.resolve(__dirname,'..'),release=path.join(root,'src-tauri/target/release'),output=path.join(root,'dist/AtlasChat');
 await fs.mkdir(output,{recursive:true});
 await fs.copyFile(path.join(release,'atlaschat-tauri.exe'),path.join(output,'AtlasChat.exe'));
 for(const name of ['node','backend'])await fs.cp(path.join(root,'src-tauri/resources',name),path.join(output,name),{recursive:true});
 await fs.writeFile(path.join(output,'README.txt'),'Run AtlasChat.exe. Keep the node and backend folders beside it. Windows 11 x64 and Microsoft WebView2 Runtime are required. Personal data and models are not bundled. See the source project BUILD.md and TESTING.md.\r\n');
 console.log('Portable application prepared: '+output);
}
main().catch(error=>{console.error(error);process.exitCode=1});
