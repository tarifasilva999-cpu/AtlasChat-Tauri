'use strict';
const fs=require('node:fs/promises');
// Windows scanners and preview readers can briefly hold the destination. Keep
// atomic replacement; never delete a valid destination to make rename succeed.
async function atomicRename(source,destination){
 for(let attempt=0;;attempt++){
  try{return await fs.rename(source,destination)}catch(error){
   if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=5)throw error;
   await new Promise(resolve=>setTimeout(resolve,25*2**attempt));
  }
 }
}
module.exports={atomicRename};
