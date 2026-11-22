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
  const instructions=`\n\nINLINE VISUALS: Include one focused visual when requested or when exploring the answer through interaction adds something useful, such as comparing options, adjusting a simulation, or opening details on a timeline. Place it between relevant paragraphs.
Use one atlas-ui fenced block (atlas-ui-wide for a genuinely wider visual). Put the opening and closing triple backticks on their own lines. Inside, put a <style> block, semantic HTML (and inline SVG or canvas if useful), and a plain inline <script> after the markup for interactions. Use native buttons and labeled inputs. Wire each control to visible panels, values, or graphics with addEventListener. Include a useful initial view and keep it usable on narrow screens and with a keyboard. Use Atlas theme variables such as --sans, --surface, --text, and --line. Keep the visual self-contained, with no libraries, external assets, network calls, or invented live data. Use normal code fences when the user asks for source code or files.`;
  function wantsVisual(text){
    const source=String(text||"");
    return /\b(?:inline (?:visual|demo|widget|chart|diagram|simulation)|in-chat (?:visual|demo|widget|chart|diagram|simulation)|(?:visual|demo|widget|chart|diagram|simulation) (?:right )?(?:in|inside) (?:this |the )?chat)\b/i.test(source)&&
      !/\b(?:source code|code snippet)\b/i.test(source);
  }
  const api={hasPlan,parsePlan,instructions,wantsVisual};
  if(typeof module!=="undefined"&&module.exports)module.exports={...api,safeCSS,plainText};
  if(typeof document==="undefined")return;
  const records=new WeakMap();
  const uid=()=>globalThis.crypto?.randomUUID?.()||`atlas-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const allowed=new Set("div span p section article header footer main aside nav h1 h2 h3 h4 h5 h6 ul ol li dl dt dd strong b em i small mark blockquote pre code br hr table caption thead tbody tfoot tr th td details summary label input button textarea select option optgroup fieldset legend output meter progress img figure figcaption a style canvas svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop clippath mask title desc pattern use".split(" "));
  const blocked=new Set("script iframe frame frameset object embed link meta base video audio source foreignobject animate animatetransform set".split(" "));
  function safeCSS(css){
    return String(css||"").replace(/@import\b[^;]*;?/gi,"").replace(/url\s*\(([^)]*)\)/gi,(_,value)=>{
      const url=value.trim().replace(/^['"]|['"]$/g,"");
      return /^#[\w-]+$/.test(url)?`url(${url})`:"none";
    }).replace(/expression\s*\([^)]*\)/gi,"").replace(/(?:-moz-binding|behavior)\s*:[^;}]*/gi,"");
  }
  function sanitize(source,interactive){
    const template=document.createElement("template");
    template.innerHTML=String(source||"");
    const scripts=[];
    for(const node of [...template.content.querySelectorAll("*")]){
      if(!template.content.contains(node))continue;
      const tag=node.localName.toLowerCase();
      if(tag==="script"){
        const type=(node.getAttribute("type")||"").trim().toLowerCase();
        if(interactive&&node.namespaceURI==="http://www.w3.org/1999/xhtml"&&!node.hasAttribute("src")&&
          /^(?:|text\/javascript|application\/javascript)$/.test(type)&&node.textContent.trim())scripts.push(node.textContent);
        node.remove();continue;
      }
      if(blocked.has(tag)||(tag==="title"&&node.namespaceURI==="http://www.w3.org/1999/xhtml")){node.remove();continue;}
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
      if(tag==="input"&&/^(?:file|image|password|hidden)$/i.test(node.type))node.remove();
    }
    return {markup:template.innerHTML,scripts};
  }
  function hasReadableLabels(markup){
    const template=document.createElement("template");
    template.innerHTML=String(markup||"");
    const labels=[...template.content.querySelectorAll("[aria-label],img[alt],input[value],title,desc")]
      .map(node=>node.getAttribute("aria-label")||node.getAttribute("alt")||node.getAttribute("value")||node.textContent||"").join(" ");
    template.content.querySelectorAll("style").forEach(node=>node.remove());
    const text=`${template.content.textContent||""} ${labels}`.replace(/\s+/g,"").trim();
    return text.length>=3;
  }
  function theme(){
    const computed=getComputedStyle(document.documentElement),values={};
    for(const name of ["bg","surface","surface-2","text","text-2","muted","line","sans"])values[`--${name}`]=computed.getPropertyValue(`--${name}`).trim();
    return values;
  }
  const baseCSS=`
    html,body{margin:0!important;padding:0!important;min-height:0!important;background:transparent!important}
    body{font:14px/1.55 var(--sans,system-ui,sans-serif);color:var(--text);-webkit-font-smoothing:antialiased}
    *,*:before,*:after{box-sizing:border-box}
    #atlas-inline-root{display:flow-root;max-width:100%;overflow-wrap:anywhere}
    #atlas-inline-root>*,img,svg,canvas,table{max-width:100%}
    img{height:auto}
    h1,h2,h3,h4,h5,h6{line-height:1.25}
    p{margin:0 0 12px}
    ul,ol{padding-left:20px}li{margin:4px 0}
    pre{overflow:auto;padding:14px;background:var(--bg);border-radius:8px}
    code{font-family:ui-monospace,monospace;font-size:.9em}
    summary{cursor:pointer;color:var(--text);font-weight:600}
    details{padding:10px 0}details>p{margin:10px 0 0}
    button,input,select,textarea{font:inherit;color:inherit;max-width:100%;accent-color:var(--text)}
    button,select{background:var(--surface-2);border:1px solid var(--line);border-radius:5px;padding:4px 9px}
    button:enabled{cursor:pointer}
    :focus-visible{outline:2px solid var(--text);outline-offset:2px}
    a{color:inherit}
    html[data-reduce-motion=true] *,html[data-reduce-motion=true] *:before,html[data-reduce-motion=true] *:after{animation:none!important;transition:none!important}
  `;
  function runVisual(id,scripts){
    const root=document.getElementById("atlas-inline-root");
    let lastHeight=0;
    function measure(){
      const height=Math.ceil(root.getBoundingClientRect().height);
      if(height===lastHeight)return;
      lastHeight=height;
      parent.postMessage({atlasInline:id,height},"*");
    }
    new ResizeObserver(measure).observe(root);
    addEventListener("load",measure,{once:true});
    root.addEventListener("change",()=>{
      const checked=[...root.querySelectorAll('input[type="checkbox"],input[type="radio"]')].map(input=>input.checked);
      parent.postMessage({atlasInline:id,checked},"*");
    });
    addEventListener("message",event=>{
      if(event.source!==parent||event.data?.atlasInline!==id)return;
      for(const [key,value] of Object.entries(event.data.theme))document.documentElement.style.setProperty(key,value);
      document.documentElement.dataset.reduceMotion=String(event.data.reduceMotion);
    });
    for(const source of scripts){
      const script=document.createElement("script");
      script.textContent=source;
      document.body.appendChild(script);
    }
    measure();
  }
  function documentFor(record){
    const colors=Object.entries(theme()).map(([key,value])=>`${key}:${value}`).join(";");
    const scripts=JSON.stringify(record.scripts).replace(/</g,"\\u003c");
    const bootstrap=`(${runVisual})(${JSON.stringify(record.id)},${scripts})`;
    return `<!doctype html><html data-reduce-motion="${document.documentElement.dataset.reduceMotion==="true"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; script-src-attr 'none'; img-src data:; base-uri 'none'; form-action 'none'"><style>:root{${colors}}${baseCSS}</style></head><body><div id="atlas-inline-root">${record.markup}</div><script>${bootstrap}</script></body></html>`;
  }
  function render(wrapper,source,options={}){
    const {markup,scripts}=sanitize(source,options.interactive===true);
    if(!hasReadableLabels(markup))return false;
    const frame=document.createElement("iframe"),shell=document.createElement("section");
    frame.className="atlas-ui-frame";
    frame.title="Inline visual";
    frame.setAttribute("sandbox","allow-scripts");
    frame.setAttribute("referrerpolicy","no-referrer");
    shell.className=`atlas-ui-shell atlas-ui-shell--${options.size==="wide"?"wide":"compact"}`;
    const record={id:uid(),markup,scripts,checked:[]};
    records.set(frame,record);
    frame.srcdoc=documentFor(record);
    shell.appendChild(frame);
    wrapper.appendChild(shell);
    return true;
  }
  function tryRawMarkup(wrapper,source,options){
    if(!/```/.test(source)&&/<style\b/i.test(source)&&/<(?:article|section)\b/i.test(source)){
      const start=String(source).search(/<(?:style|article|section)\b/i);
      if(!render(wrapper,String(source).slice(start)))return false;
      if(start>0){const intro=document.createElement("div");intro.innerHTML=options.markdown(String(source).slice(0,start));wrapper.prepend(intro);}
      return true;
    }
    return false;
  }
  addEventListener("message",event=>{
    if(event.origin!=="null"||typeof event.data?.atlasInline!=="string")return;
    for(const frame of document.querySelectorAll(".atlas-ui-frame")){
      const record=records.get(frame);
      if(event.source!==frame.contentWindow||event.data.atlasInline!==record?.id)continue;
      if(Number.isFinite(event.data.height)){
        const height=`${Math.max(1,Math.min(4096,Math.ceil(event.data.height)))}px`;
        if(frame.style.height!==height){
          frame.style.height=height;
          document.dispatchEvent(new CustomEvent("atlas-inline-ui-resize"));
        }
      }
      if(Array.isArray(event.data.checked))record.checked=event.data.checked.slice(0,256).map(Boolean);
      break;
    }
  });
  new MutationObserver(()=>{
    const values=theme(),reduceMotion=document.documentElement.dataset.reduceMotion==="true";
    for(const frame of document.querySelectorAll(".atlas-ui-frame")){
      const record=records.get(frame);
      if(record)frame.contentWindow?.postMessage({atlasInline:record.id,theme:values,reduceMotion},"*");
    }
  }).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme","data-reduce-motion"]});
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
        [...fragment.querySelectorAll('input[type="checkbox"],input[type="radio"]')].forEach((input,index)=>{
          if(record.checked[index]!==undefined)input.checked=record.checked[index];
        });
        shell.replaceWith(fragment);
      }else shell.remove();
    });
    clone.querySelectorAll("style,script,.code-copy,.cursor,.pause-spinner").forEach(node=>node.remove());
    clone.querySelectorAll("svg").forEach(node=>{const text=[...node.querySelectorAll("text,title,desc")].map(item=>item.textContent).join(" · ");node.replaceWith(document.createTextNode(text));});
    clone.querySelectorAll("input").forEach(node=>node.replaceWith(document.createTextNode(
      /^(?:checkbox|radio)$/.test(node.type)?(node.checked?"☑ ":"☐ "):(node.getAttribute("aria-label")||node.value)
    )));
    clone.querySelectorAll("img").forEach(node=>{if(!node.getAttribute("src"))node.replaceWith(document.createTextNode(node.alt||""));});
    const text=plainText(clone).replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
    return {text:text||String(fallback||""),html:clone.innerHTML};
  }
  Object.assign(api,{render,tryRawMarkup,copyPayload});
  window.AtlasInlineUI=api;
})();
