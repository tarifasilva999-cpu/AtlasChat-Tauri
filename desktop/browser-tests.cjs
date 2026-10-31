'use strict';
function validateTests(value) {
  if (!value || !Array.isArray(value.tests) || value.tests.length < 1 || value.tests.length > 20) throw new Error('Behavior verification requires project.tests.json with 1–20 tests.');
  let assertions=0;
  for(const test of value.tests) {
    if(!Array.isArray(test.steps)||!test.steps.length||test.steps.length>30)throw new Error('Tests need 1–30 steps.');
    for(const step of test.steps) {
      if(!['click','type','keydown','assert','wait'].includes(step.action))throw new Error('Unsupported browser test action.');
      if(step.action==='wait'){if(!Number.isFinite(step.ms)||step.ms<0||step.ms>1500)throw new Error('Wait must be 0–1500 ms.');continue;}
      if(typeof step.selector!=='string'||step.selector.length>250)throw new Error('Test selector missing or too long.');
      if(step.action==='assert'){
        if(!['text','value','count','attribute','visible'].includes(step.property)||!Object.hasOwn(step,'equals'))throw new Error('Assertions need a supported property and equals.');
        if(step.property==='attribute'&&!/^[a-z][\w-]*$/i.test(step.attribute||''))throw new Error('Assertion attribute missing.');
        assertions++;
      }
      if(step.action==='type'&&(typeof step.value!=='string'||step.value.length>1000))throw new Error('Type value invalid.');
      if(step.action==='keydown'&&(typeof step.key!=='string'||step.key.length>30))throw new Error('Key invalid.');
    }
    if(!test.steps.some(s=>s.action==='assert'))throw new Error('Each behavior test must assert an outcome.');
  }
  return {tests:value.tests,assertions};
}
function stepCode(step) {
  return `(() => {
    const s=${JSON.stringify(step)}, elements=document.querySelectorAll(s.selector), el=elements[0];
    if(s.action==='assert'&&s.property==='count')return {actual:elements.length,passed:elements.length===s.equals};
    if(!el)throw new Error('Element missing: '+s.selector);
    if(s.action==='click'){el.click();return {passed:true};}
    if(s.action==='type'){el.value=s.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {passed:true};}
    if(s.action==='keydown'){el.dispatchEvent(new KeyboardEvent('keydown',{key:s.key,bubbles:true}));return {passed:true};}
    let actual;
    if(s.property==='text')actual=el.textContent.trim();
    if(s.property==='value')actual=el.value;
    if(s.property==='attribute')actual=el.getAttribute(s.attribute);
    if(s.property==='visible')actual=!!(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');
    return {actual,passed:actual===s.equals};
  })()`;
}
async function runBrowserTests(contents, spec) {
  const {tests,assertions}=validateTests(spec),results=[];
  const deadline=Date.now()+20000;
  for(const test of tests) {
    let failure=null;
    for(const step of test.steps) {
      try {
        if(Date.now()>deadline||contents.isDestroyed?.())throw new Error('Browser test time limit or window closed.');
        if(step.action==='wait'){await new Promise(r=>setTimeout(r,step.ms));continue;}
        const result=await contents.executeJavaScriptInIsolatedWorld(999,[{code:stepCode(step)}]);
        if(!result.passed){failure={selector:step.selector,expected:step.equals,actual:result.actual};break;}
      }catch(e){failure={message:String(e.message).slice(0,600)};break;}
    }
    results.push({name:String(test.name||'Behavior test').slice(0,100),passed:!failure,...(failure?{failure}:{})});
  }
  return {passed:results.every(r=>r.passed),assertions,tests:results};
}
module.exports={validateTests,stepCode,runBrowserTests};
