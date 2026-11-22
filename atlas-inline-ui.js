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
  const designGuidance="VISUAL DESIGN: Follow the user's art direction or existing design system. Otherwise choose typography for the subject, use a consistent spacing scale, group related controls, align labels and values, and use neutral surfaces with one purposeful accent. Avoid default Inter typography, purple-to-cyan gradients, neon glows, repeated cards, and pill buttons. Give buttons clear action labels and lightly rounded corners. Use color to convey meaning and pair it with readable labels.";
  const instructions=`\n\nINLINE VISUALS: Use atlas-ui for a chart, graph, infographic, diagram, or interactive illustration that helps explain this reply. Place it between relevant paragraphs. A requested game, website, app, downloadable document, or archive is a standalone deliverable. Use the applicable code, file, or project workflow for it. A request to see source code gets a language-labeled code block.
Use one atlas-ui fenced block (atlas-ui-wide for a genuinely wider visual). Put the opening and closing triple backticks on their own lines. Inside, put a <style> block and semantic HTML, with SVG or canvas where useful. On the outer visual element, optionally set data-atlas-width and data-atlas-height to pixel numbers. Omit height to fit the contents. Set data-atlas-resizable="true" only when user resizing is useful. Atlas limits width to the available chat space. Add a plain inline <script> after the markup only for real interactions. Use native buttons and labeled inputs. Wire each control to visible panels, values, or graphics with addEventListener. Include a useful initial view and keep it usable on narrow screens and with a keyboard. Use Atlas theme variables such as --sans, --surface, --text, and --line. Keep visuals self-contained, with no libraries, external assets, network calls, or invented live data. Label chart axes, units, and legends where needed. ${designGuidance}`;
  function wantsStandalone(text){
    return /\b(?:build|create|make|develop|implement|generate|write|code)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the)\s+)?(?:(?!(?:chart|graph|diagram|infographic|visual|planner|for|of|about|to)\b)[\w-]+\s+){0,3}(?:game|website|webpage|web page|landing page|web app|application|app)\b/i.test(text);
  }
  function wantsArchive(text){
    return /\b(?:as|into|in|to)\s+(?:a\s+)?(?:zip(?: file)?|archive)\b|\b(?:create|make|generate|download|export|package|give me|send me)\s+(?:a\s+)?(?:zip(?: file)?|archive)\b|\b(?:downloadable zip|zip up)\b/i.test(text);
  }
  function wantsVisual(text){
    const source=String(text||"");
    if(wantsStandalone(source)||wantsArchive(source)||
      /\b(?:source code|code snippet|code block|downloadable|(?:as|export|save)\s+(?:a\s+)?(?:pdf|html file)|(?:write|show|provide|output)\s+(?:the\s+)?(?:html|css|javascript|js|code)|(?:write|generate|provide|implement)\s+(?:a\s+)?(?:\w+\s+){0,2}(?:script|function|program))\b/i.test(source))return false;
    const visual=/\b(?:(?:inline|in-chat|interactive) (?:visual|demo|widget|chart|graph|diagram|infographic|simulation|planner|timer|calculator)|(?:visual|demo|widget|chart|graph|diagram|infographic|simulation|planner|timer|calculator) (?:right )?(?:in|inside) (?:this |the )?chat)\b/i;
    const illustration=/\b(?:visuali[sz]e|plot)\b|\b(?:show|draw|make|create|generate|illustrate)(?:\s+\w+){0,4}\s+(?:chart|graph|diagram|infographic|visual representation)\b/i;
    return visual.test(source)||illustration.test(source);
  }
  function preferredSize(value,min,max){
    const number=Number(value);
    return Number.isFinite(number)&&number>0?Math.round(Math.min(max,Math.max(min,number))):null;
  }
  function hasUnsupportedToolCall(value, includeFencedCode = false) {
    const text = String(value || '');
    const source = includeFencedCode ? text : text.replace(/^[ \t]*`{3}[^\r\n]*\r?\n[\s\S]*?(?:^[ \t]*`{3}[^\r\n]*|(?![\s\S]))/gm, '');
    return /<\|(?:tool_call|tool_result|tool_response)(?:\|)?>|<\/(?:tool_call|tool_result|tool_response)>/i.test(source) ||
      /\bcall:(?:CodeEdit|CodeInterpreter)\s*\{/i.test(source) ||
      /\b(?:file_path|old_string|new_string)\s*:\s*<\|/i.test(source);
  }
  const api={hasPlan,parsePlan,instructions,designGuidance,wantsVisual,wantsStandalone,wantsArchive,hasUnsupportedToolCall};
  if(typeof module!=="undefined"&&module.exports)module.exports={...api,safeCSS,plainText,preferredSize};
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
    const layout=interactive?template.content.querySelector("[data-atlas-width],[data-atlas-height],[data-atlas-resizable]")?.dataset:null;
    const scripts=[],buttonHandlers=[];
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
        if(interactive&&tag==="button"&&name==="onclick"){
          node.setAttribute("data-atlas-button-handler",String(buttonHandlers.length));
          buttonHandlers.push(value);
        }
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
    if(buttonHandlers.length){
      scripts.push(`(()=>{const buttons=document.querySelectorAll("#atlas-inline-root button[data-atlas-button-handler]");
        const handlers=[${buttonHandlers.map(source=>`function(event){\n${source}\n}`).join(",")}];
        for(const button of buttons){
          const handler=handlers[Number(button.dataset.atlasButtonHandler)];
          if(handler)button.addEventListener("click",function(event){if(handler.call(this,event)===false)event.preventDefault()});
        }
      })();`);
    }
    return {markup:template.innerHTML,scripts,layout};
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
    html,body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;background:transparent!important}
    body{font:14px/1.55 var(--sans,system-ui,sans-serif);color:var(--text);-webkit-font-smoothing:antialiased}
    *,*:before,*:after{box-sizing:border-box}
    :root{--font-sans:var(--sans);--background:var(--bg);--border:var(--line)}
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
    let failed=false;
    addEventListener("error",()=>{
      if(failed)return;
      failed=true;
      const notice=document.createElement("p");
      notice.textContent="This interactive visual couldn’t run. Try regenerating the reply.";
      root.replaceChildren(notice);
    });
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
      if(failed)break;
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
    const {markup,scripts,layout}=sanitize(source,options.interactive===true);
    if(!hasReadableLabels(markup))return false;
    const frame=sandboxFrame("Inline visual"),shell=document.createElement("section");
    frame.className="atlas-ui-frame";
    shell.className=`atlas-ui-shell atlas-ui-shell--${options.size==="wide"?"wide":"compact"}`;
    const width=preferredSize(layout?.atlasWidth,180,1200),height=preferredSize(layout?.atlasHeight,120,4096);
    const resizable=layout?.atlasResizable==="true";
    const record={id:uid(),markup,scripts,checked:[],fixedHeight:Boolean(height)};
    if(width||resizable)shell.classList.add("atlas-ui-shell--custom");
    if(width)shell.style.width=`${width}px`;
    if(height)frame.style.height=`${height}px`;
    records.set(frame,record);
    frame.srcdoc=documentFor(record);
    shell.appendChild(frame);
    if(resizable)addResizeHandle(shell,frame,()=>shell.parentElement.clientWidth,()=>4096,
      (width,height)=>{
        record.fixedHeight=true;
        shell.style.width=`${width}px`;
        frame.style.height=`${height}px`;
        document.dispatchEvent(new CustomEvent("atlas-inline-ui-resize"));
      });
    wrapper.appendChild(shell);
    return true;
  }
  function sandboxFrame(title){
    const frame=document.createElement("iframe");
    frame.title=title;
    frame.setAttribute("sandbox","allow-scripts");
    frame.setAttribute("referrerpolicy","no-referrer");
    return frame;
  }
  function addResizeHandle(container,measure,maxWidth,maxHeight,resize){
    const handle=document.createElement("button");
    handle.type="button";
    handle.className="atlas-resize-handle";
    handle.setAttribute("aria-label","Resize with arrow keys");
    handle.title="Drag to resize or use the arrow keys";
    const apply=(width,height)=>resize(
      Math.round(Math.min(maxWidth(),Math.max(180,width))),
      Math.round(Math.min(maxHeight(),Math.max(120,height)))
    );
    let drag;
    handle.addEventListener("pointerdown",event=>{
      if(event.button!==0||drag)return;
      const rect=measure.getBoundingClientRect();
      drag={id:event.pointerId,x:event.clientX,y:event.clientY,width:rect.width,height:rect.height};
      handle.setPointerCapture(event.pointerId);
      container.classList.add("atlas-resizing");
    });
    handle.addEventListener("pointermove",event=>{
      if(drag?.id===event.pointerId)apply(drag.width+event.clientX-drag.x,drag.height+event.clientY-drag.y);
    });
    handle.addEventListener("lostpointercapture",()=>{
      drag=null;
      container.classList.remove("atlas-resizing");
    });
    handle.addEventListener("keydown",event=>{
      const horizontal=Number(event.key==="ArrowRight")-Number(event.key==="ArrowLeft");
      const vertical=Number(event.key==="ArrowDown")-Number(event.key==="ArrowUp");
      if(!horizontal&&!vertical)return;
      event.preventDefault();
      const rect=measure.getBoundingClientRect(),step=event.shiftKey?48:16;
      apply(rect.width+horizontal*step,rect.height+vertical*step);
    });
    container.appendChild(handle);
  }
  function reportPreviewErrors(id){
    const report=message=>parent.postMessage({atlasHtmlPreview:id,message:String(message).slice(0,300)},"*");
    addEventListener("error",event=>{
      if(event.target===window){
        report(event.message||"The preview encountered a script error.");
      }else{
        report("An asset could not load. Preview supports self-contained HTML.");
      }
    },true);
    addEventListener("unhandledrejection",event=>report(event.reason?.message||event.reason||"An asynchronous operation failed."));
  }
  function previewDocument(source,id){
    const content=String(source||"").replace(/^\s*<!doctype[^>]*>/i,"");
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'"><script>(${reportPreviewErrors})(${JSON.stringify(id)})</script>${content}`;
  }
  function showHtmlPreview(filename,contents){
    const dialog=document.createElement("dialog");
    dialog.className="atlas-html-preview";
    const header=document.createElement("header");
    const title=document.createElement("h2");
    title.id=uid();
    title.textContent=filename;
    dialog.setAttribute("aria-labelledby",title.id);
    const reload=document.createElement("button"),close=document.createElement("button");
    reload.type=close.type="button";
    reload.textContent="Reload";
    close.textContent="Close";
    close.autofocus=true;
    close.onclick=()=>dialog.close();
    const frame=sandboxFrame("Preview of "+filename);
    const status=document.createElement("p");
    status.className="atlas-preview-error";
    status.setAttribute("role","status");
    const controller=new AbortController();
    let id;
    reload.onclick=()=>{
      id=uid();
      status.textContent="";
      frame.srcdoc=previewDocument(contents,id);
    };
    addEventListener("message",event=>{
      if(event.origin!=="null"||event.source!==frame.contentWindow||event.data?.atlasHtmlPreview!==id)return;
      if(typeof event.data.message==="string")status.textContent=event.data.message.slice(0,300);
    },{signal:controller.signal});
    dialog.addEventListener("close",()=>{
      controller.abort();
      dialog.remove();
    },{once:true});
    header.append(title,reload,close);
    dialog.append(header,status,frame);
    addResizeHandle(dialog,dialog,
      ()=>innerWidth-dialog.getBoundingClientRect().left-12,
      ()=>innerHeight-dialog.getBoundingClientRect().top-12,
      (width,height)=>{
        dialog.style.width=`${width}px`;
        dialog.style.height=`${height}px`;
      });
    document.body.appendChild(dialog);
    dialog.showModal();
    reload.onclick();
  }
  function htmlPreviewButton(filename,load){
    if(!/\.html?$/i.test(filename))return null;
    const button=document.createElement("button");
    button.type="button";
    button.className="file-download atlas-file-preview-button";
    button.textContent="▶ Preview";
    button.setAttribute("aria-label","Preview "+filename);
    button.onclick=async()=>{
      button.disabled=true;
      try{
        showHtmlPreview(filename,await load());
      }catch(error){
        showHtmlPreview(filename,"<p>Atlas couldn’t open this file for preview.</p>");
      }finally{
        button.disabled=false;
      }
    };
    return button;
  }
  function tryRawMarkup(wrapper,source,options){
    const start=String(source).search(/<(?:!doctype\b|html\b|style\b|article\b|section\b|div\b|canvas\b|svg\b)/i);
    const markup=String(source).slice(start);
    const rawVisual=options.interactive
      ? /<(?:style|script|canvas|svg|button|input|select|details)\b/i.test(markup)
      : /<style\b/i.test(markup)&&/<(?:article|section)\b/i.test(markup);
    if(start>=0&&!/```/.test(source)&&rawVisual){
      if(!render(wrapper,markup,{interactive:options.interactive}))appendUnavailable(wrapper);
      if(start>0){const intro=document.createElement("div");intro.innerHTML=options.markdown(String(source).slice(0,start));wrapper.prepend(intro);}
      return true;
    }
    return false;
  }
  function appendUnavailable(wrapper,message="This visual couldn’t be displayed. Try regenerating the reply."){
    const notice=document.createElement("p");
    notice.textContent=message;
    wrapper.appendChild(notice);
  }
  addEventListener("message",event=>{
    if(event.origin!=="null"||typeof event.data?.atlasInline!=="string")return;
    for(const frame of document.querySelectorAll(".atlas-ui-frame")){
      const record=records.get(frame);
      if(event.source!==frame.contentWindow||event.data.atlasInline!==record?.id)continue;
      if(!record.fixedHeight&&Number.isFinite(event.data.height)){
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
    clone.querySelectorAll("style,script,.code-copy,.atlas-file-preview-button,.cursor,.pause-spinner").forEach(node=>node.remove());
    clone.querySelectorAll("svg").forEach(node=>{const text=[...node.querySelectorAll("text,title,desc")].map(item=>item.textContent).join(" · ");node.replaceWith(document.createTextNode(text));});
    clone.querySelectorAll("input").forEach(node=>node.replaceWith(document.createTextNode(
      /^(?:checkbox|radio)$/.test(node.type)?(node.checked?"☑ ":"☐ "):(node.getAttribute("aria-label")||node.value)
    )));
    clone.querySelectorAll("img").forEach(node=>{if(!node.getAttribute("src"))node.replaceWith(document.createTextNode(node.alt||""));});
    const text=plainText(clone).replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
    return {text:text||String(fallback||""),html:clone.innerHTML};
  }
  Object.assign(api,{render,tryRawMarkup,appendUnavailable,copyPayload,htmlPreviewButton});
  window.AtlasInlineUI=api;
})();
