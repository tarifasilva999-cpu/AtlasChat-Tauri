'use strict';
const {runId}=require('./core.cjs');
async function verifyProject({store,runner,preview,checking,cancelled},id) {
  runId(id);if(checking.size)throw new Error('Another project check is running.');checking.add(id);
  try {
    cancelled.delete(id);const result=await runner.check(id);
    if(result.needsPreview&&!result.cancelled&&!result.reason&&!cancelled.has(id)){
      try{const check=await preview(id);result.checks.push(check);result.executed=true;result.passed=check.exitCode===0;result.behaviorVerified=check.behaviorVerified;result.verifiedCommands=[...(result.verifiedCommands||[]),...(check.exitCode===0?[check.command]:[])];if(!result.passed)result.reason='Browser runtime or behavior verification failed.';}
      catch(error){result.executed=true;result.passed=false;result.reason=String(error.message);result.checks.push({command:'Browser runtime check',executed:true,exitCode:1,output:String(error.message)});}
    }
    if(cancelled.has(id)){result.cancelled=true;result.passed=false;result.reason='Run stopped.';}
    const run=await store.read(id);
    if(run.sourceHash!==result.sourceHash){result.passed=false;result.reason='Workspace changed during verification. Run checks again.';}
    run.lastCheck=result;
    if(result.passed&&result.behaviorVerified)run.lastSuccessfulBuild={at:Date.now(),sourceHash:run.sourceHash,commands:result.verifiedCommands||[]};
    await store.put(run);return result;
  }finally{
    try{await runner.cleanupWork(id);}catch(error){
      try{const run=await store.read(id);run.lastCheck={...(run.lastCheck||{}),passed:false,reason:'Temporary run files could not be removed: '+String(error.message)};await store.put(run);}catch{}
    }finally{checking.delete(id);}
  }
}
function completionStatus(run,interrupted=false) {
  return interrupted?'interrupted':run.lastCheck?.passed&&run.lastCheck.behaviorVerified&&run.lastCheck.sourceHash===run.sourceHash?'checked':'incomplete';
}
module.exports={verifyProject,completionStatus};
