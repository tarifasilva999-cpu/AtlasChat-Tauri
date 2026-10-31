/* Model-authored inline layouts and visuals. */
(()=>{
  "use strict";
  const cleanLabel=value=>String(value||"").replace(/^#+\s*/,"").replace(/\*\*|__/g,"").trim();
  const heading=/^\s*#{1,6}\s+(.+)$/;
  function hasPlan(source){
    const raw=String(source||"");
    if(/```(?:atlas-ui|atlas-plan)\b/i.test(raw))return false;
    const text=raw.replace(/```[\s\S]*?(?:```|$)/g,"");
    return /^\s*#{1,6}\s+(?:plan card|your plan|action plan|roadmap)\s*$/im.test(text)||
      (/core idea\s*:?/i.test(text)&&/first version\s*:?/i.test(text)&&/next step\s*:?/i.test(text))||
      ((text.match(/^\s*#{1,6}\s+step\s+\d+/gim)||[]).length>=2&&/\b(?:plan|roadmap)\b/i.test(text));
  }
  function parsePlan(raw){
    const source=String(raw||"").replace(/\r/g,"");
    const plan={title:"Your plan",intro:"",overview:[],sections:[],closing:""};
    const lines=source.split("\n");
    let current=null,started=false,inCode=false;
    const flush=()=>{
      if(!current)return;
      const body=current.lines.join("\n").trim();
      if(body||current.title)plan[current.kind].push({title:current.title,body});
      current=null;
    };
    for(const line of lines){
      if(/^\s*```/.test(line))inCode=!inCode;
      const label=!inCode&&line.match(/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(CORE IDEA|FIRST VERSION|NEXT STEP|VISUAL)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.*)$/i);
      const title=!inCode&&line.match(heading);
      if(label){
        flush();started=true;
        current={kind:"overview",title:cleanLabel(label[1]).toLowerCase().replace(/^./,char=>char.toUpperCase()),lines:[label[2]]};
      }else if(title){
        const name=cleanLabel(title[1]);
        if(/^(?:plan card|your plan|action plan|detailed steps|steps|roadmap)$/i.test(name)){
          flush();started=true;
          if(/^roadmap$/i.test(name)&&plan.title==="Your plan")plan.title=name;
        }else if(!started){
          started=true;plan.title=name;
        }else{
          flush();current={kind:"sections",title:name,lines:[]};
        }
      }else if(!inCode&&current?.kind==="sections"&&/^(?:Next action\s*:|By following these|With these steps|To get started)/i.test(cleanLabel(line))){
        flush();plan.closing+=(plan.closing?"\n":"")+line;
      }else if(current){
        current.lines.push(line);
      }else if(!started){
        plan.intro+=(plan.intro?"\n":"")+line;
      }else{
        plan.closing+=(plan.closing?"\n":"")+line;
      }
    }
    flush();plan.intro=plan.intro.trim();plan.closing=plan.closing.trim();
    const subject=plan.intro.match(/idea for (?:a |an |the )?(.+?)[!.]/i)?.[1];
    if(plan.title==="Your plan"&&subject)plan.title=subject.replace(/^./,char=>char.toUpperCase());
    return plan;
  }
  const instructions="\n\nINLINE PLAN VISUALS: Put one focused visual inside the prose of a substantial plan; keep the rest as normal conversation. Choose a form that fits the plan, with no fixed card template. Make the graphic small and specific, with visible labels and a few meaningful steps, nodes, or relationships. Prefer inline SVG or simple HTML/CSS. Never emit unexplained color blocks, blank graphics, or a grid of text cards. Use ```atlas-ui for compact inserts (up to 560px); use ```atlas-ui-wide only when the idea genuinely needs more room. Use Atlas's --sans font, charcoal surfaces, readable contrast, and restrained separators. Only self-contained HTML/CSS/SVG is available: no scripts, event handlers, forms, external resources, or invented image URLs. A visual is illustrative; it does not mean Atlas searched or took action.";
  const api={hasPlan,parsePlan,instructions};
  if(typeof module!=="undefined"&&module.exports)module.exports={...api,safeCSS,plainText};
  if(typeof document==="undefined")return;
  const pools=new WeakMap(),records=new WeakMap(),live=new Set();
  const uid=()=>globalThis.crypto?.randomUUID?.()||`atlas-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const allowed=new Set("div span p section article header footer main aside nav h1 h2 h3 h4 h5 h6 ul ol li strong b em i small mark blockquote pre code br hr table caption thead tbody tfoot tr th td details summary label input img figure figcaption a style svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop clippath mask title desc pattern use".split(" "));
  const blocked=new Set("script iframe object embed link meta base form button textarea select video audio source canvas foreignobject animate animatetransform set".split(" "));
  function safeCSS(css){
    return String(css||"").replace(/@import\b[^;]*;?/gi,"").replace(/url\s*\(([^)]*)\)/gi,(_,value)=>{
      const url=value.trim().replace(/^['"]|['"]$/g,"");
      return /^#[\w-]+$/.test(url)?`url(${url})`:"none";
    }).replace(/expression\s*\([^)]*\)/gi,"").replace(/(?:-moz-binding|behavior)\s*:[^;}]*/gi,"");
  }
  function sanitize(source){
    const template=document.createElement("template");
    template.innerHTML=String(source||"");
    for(const node of [...template.content.querySelectorAll("*")]){
      const tag=node.localName.toLowerCase();
      if(blocked.has(tag)){node.remove();continue;}
      if(!allowed.has(tag)){node.replaceWith(...node.childNodes);continue;}
      if(tag==="style")node.textContent=safeCSS(node.textContent);
      for(const attr of [...node.attributes]){
        const name=attr.name.toLowerCase(),value=attr.value;
        if(name.startsWith("on")||["srcdoc","action","formaction","form","autofocus","target","download","ping","srcset"].includes(name))node.removeAttribute(attr.name);
        else if(name==="style")node.setAttribute("style",safeCSS(value));
        else if(name==="href"||name==="xlink:href"){
          if(!/^#[\w-]+$/.test(value))node.removeAttribute(attr.name);
        }else if(name==="src"){
          if(tag!=="img"||!/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);/i.test(value))node.removeAttribute(attr.name);
        }
      }
      if(tag==="input"&&!/^(?:checkbox|radio)$/i.test(node.getAttribute("type")||""))node.replaceWith(document.createTextNode(node.getAttribute("value")||""));
    }
    return template.innerHTML;
  }
  function hasReadableLabels(markup){
    const template=document.createElement("template");
    template.innerHTML=String(markup||"");
    const labels=[...template.content.querySelectorAll("[aria-label],title,desc")]
      .map(node=>node.getAttribute("aria-label")||node.textContent||"").join(" ");
    template.content.querySelectorAll("style").forEach(node=>node.remove());
    const text=`${template.content.textContent||""} ${labels}`.replace(/\s+/g,"").trim();
    return text.length>=3;
  }
  function theme(){
    const computed=getComputedStyle(document.documentElement),values={};
    for(const name of ["bg","surface","surface-2","text","text-2","muted","line","sans"])values[`--${name}`]=computed.getPropertyValue(`--${name}`).trim();
    return values;
  }
  const baseCSS="html,body{margin:0!important;padding:0!important;min-height:0!important;background:transparent!important}body{font:14px/1.55 var(--sans,system-ui,sans-serif);color:var(--text);overflow:hidden;-webkit-font-smoothing:antialiased}*,*:before,*:after{box-sizing:border-box}#atlas-inline-root{display:flow-root;max-width:100%;overflow-wrap:anywhere}#atlas-inline-root>*{max-width:100%}img,svg,table{max-width:100%}img{height:auto}h1,h2,h3,h4,h5,h6{line-height:1.25}p{margin:0 0 12px}ul,ol{padding-left:20px}li{margin:4px 0}pre{overflow:auto;padding:14px;background:var(--bg);border-radius:8px}code{font-family:ui-monospace,monospace;font-size:.9em}summary{cursor:pointer;color:var(--text);font-weight:600}details{padding:10px 0}details>p{margin:10px 0 0}input{accent-color:var(--text)}a{color:inherit}html[data-reduce-motion=true] *,html[data-reduce-motion=true] *:before,html[data-reduce-motion=true] *:after{animation:none!important;transition:none!important}";
  function documentFor(record){
    const nonce=uid().replace(/-/g,"");
    const colors=Object.entries(theme()).map(([key,value])=>`${key}:${value}`).join(";");
    const bootstrap=`(()=>{const id=${JSON.stringify(record.id)},root=document.getElementById('atlas-inline-root'),saved=${JSON.stringify(record.state||{})};const details=[...root.querySelectorAll('details')],inputs=[...root.querySelectorAll('input')];(saved.details||[]).forEach((v,i)=>{if(details[i])details[i].open=v});(saved.inputs||[]).forEach((v,i)=>{if(inputs[i])inputs[i].checked=v});let last=0;const measure=()=>{const height=Math.ceil(root.getBoundingClientRect().height);if(Math.abs(height-last)>1){last=height;parent.postMessage({atlasInline:id,height},'*')}};new ResizeObserver(measure).observe(root);root.addEventListener('load',measure,true);const state=()=>{parent.postMessage({atlasInline:id,state:{details:details.map(n=>n.open),inputs:inputs.map(n=>n.checked)}},'*');measure()};root.addEventListener('toggle',state,true);root.addEventListener('change',state);addEventListener('message',event=>{if(event.source!==parent||event.data?.atlasInline!==id)return;for(const [key,value] of Object.entries(event.data.theme||{}))document.documentElement.style.setProperty(key,value);document.documentElement.dataset.reduceMotion=String(!!event.data.reduceMotion);measure()});measure()})()`;
    return `<!doctype html><html data-reduce-motion="${document.documentElement.dataset.reduceMotion==="true"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>:root{${colors}}${baseCSS}</style></head><body><div id="atlas-inline-root">${record.markup}</div><script nonce="${nonce}">${bootstrap}</script></body></html>`;
  }
  function begin(container){
    pools.set(container,{frames:[...container.querySelectorAll(".atlas-ui-frame")],index:0});
  }
  function applyMarkup(record){
    clearTimeout(record.updateTimer);record.updateTimer=null;
    if(record.pendingMarkup===null)return;
    record.markup=record.pendingMarkup;
    record.appliedSource=record.pendingMarkup;
    record.pendingMarkup=null;
    record.lastUpdate=Date.now();
    record.frame.srcdoc=documentFor(record);
  }
  function render(wrapper,source,options={}){
    const markup=sanitize(String(source||""));
    if(!hasReadableLabels(markup))return;
    const pool=pools.get(options.container),frame=pool?.frames[pool.index++]||document.createElement("iframe");
    let record=records.get(frame);
    const size=options.size==="wide"?"wide":"compact";
    if(!record){
      frame.className="atlas-ui-frame";frame.title="Inline visual";frame.setAttribute("sandbox","allow-scripts");frame.setAttribute("referrerpolicy","no-referrer");
      const shell=document.createElement("section");shell.className="atlas-ui-shell";shell.appendChild(frame);
      record={id:uid(),frame,shell,source:"",appliedSource:"",pendingMarkup:null,markup:"",state:{},lastUpdate:0,updateTimer:null};records.set(frame,record);live.add(record);
    }
    record.shell.className=`atlas-ui-shell atlas-ui-shell--${size}`;
    if(record.source!==markup){record.source=markup;record.pendingMarkup=markup;}
    if(record.pendingMarkup!==null){
      if(options.complete||!record.lastUpdate)applyMarkup(record);
      else if(!record.updateTimer)record.updateTimer=setTimeout(()=>applyMarkup(record),Math.max(0,500-(Date.now()-record.lastUpdate)));
    }
    wrapper.appendChild(record.shell);
    for(const item of live)if(item!==record&&!item.frame.isConnected&&!pool?.frames.includes(item.frame)){clearTimeout(item.updateTimer);live.delete(item);}
  }
  function tryRawMarkup(wrapper,source,options){
    if(!/```/.test(source)&&/<style\b/i.test(source)&&/<(?:article|section)\b/i.test(source)){
      const start=String(source).search(/<(?:style|article|section)\b/i);
      if(start>0){const intro=document.createElement("div");intro.innerHTML=options.markdown(String(source).slice(0,start));wrapper.appendChild(intro);}
      render(wrapper,String(source).slice(start),options);return true;
    }
    return false;
  }
  addEventListener("message",event=>{
    for(const record of live){
      if(event.source!==record.frame.contentWindow||event.data?.atlasInline!==record.id)continue;
      if(Number.isFinite(event.data.height)){
        record.frame.style.height=`${Math.max(1,Math.min(1000000,event.data.height))}px`;
        document.dispatchEvent(new CustomEvent("atlas-inline-ui-resize"));
      }
      if(event.data.state&&typeof event.data.state==="object")record.state={details:Array.isArray(event.data.state.details)?event.data.state.details.map(Boolean):[],inputs:Array.isArray(event.data.state.inputs)?event.data.state.inputs.map(Boolean):[]};
      break;
    }
  });
  new MutationObserver(()=>{for(const record of live)if(record.frame.isConnected)record.frame.contentWindow?.postMessage({atlasInline:record.id,theme:theme(),reduceMotion:document.documentElement.dataset.reduceMotion==="true"},"*")}).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme","data-reduce-motion"]});
  function plainText(node){
    if(node.nodeType===3)return node.textContent;
    const tag=node.localName||"";
    if(tag==="br")return "\n";
    const text=[...node.childNodes].map(plainText).join("");
    if(tag==="li")return `\n- ${text}\n`;
    if(/^(h[1-6]|p|div|section|article|header|footer|main|aside|blockquote|pre|ul|ol|details|summary|tr|figcaption)$/.test(tag))return `\n${text}\n`;
    if(/^(td|th)$/.test(tag))return `${text}\t`;
    return text;
  }
  function copyPayload(container,fallback){
    const clone=container.cloneNode(true);
    const original=[...container.querySelectorAll(".atlas-ui-frame")];
    [...clone.querySelectorAll(".atlas-ui-shell")].forEach((shell,index)=>{
      const record=records.get(original[index]);
      if(record){
        const fragment=document.createElement("div");fragment.innerHTML=record.markup;
        [...fragment.querySelectorAll("input")].forEach((input,index)=>{if(record.state.inputs?.[index]!==undefined)input.checked=record.state.inputs[index];});
        shell.replaceWith(fragment);
      }else shell.remove();
    });
    clone.querySelectorAll("style,script,.code-copy,.cursor,.pause-spinner").forEach(node=>node.remove());
    clone.querySelectorAll("svg").forEach(node=>{const text=[...node.querySelectorAll("text,title,desc")].map(item=>item.textContent).join(" · ");node.replaceWith(document.createTextNode(text));});
    clone.querySelectorAll("input").forEach(node=>node.replaceWith(document.createTextNode(node.checked?"☑ ":"☐ ")));
    clone.querySelectorAll("img").forEach(node=>{if(!node.getAttribute("src"))node.replaceWith(document.createTextNode(node.alt||""));});
    const text=plainText(clone).replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
    return {text:text||String(fallback||""),html:clone.innerHTML};
  }
  Object.assign(api,{begin,render,tryRawMarkup,copyPayload});
  window.AtlasInlineUI=api;
})();
