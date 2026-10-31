const CACHE = "atlas-chat-native-desktop-v18";
const SHELL = [
  "./",
  "./index.html",
  "./Atlas-CHAT.html",
  "./atlas-ui.css",
  "./atlas-inline-ui.js",
  "./atlas-native.js",
  "./atlas-coding.js",
  "./atlas-poem3.js",
  "./atlas-files.js",
  "./fonts/AtlasText-Regular.ttf",
  "./fonts/AtlasSans-Regular.ttf",
  "./fonts/AtlasSerif-Regular.ttf",
  "./atlas-mlc-worker.js",
  "./manifest.webmanifest",
  "./icons/AtlasChat Mobile.png",
  "./icons/AtlasPC.png",
  "./icons/WebLogoICON.png",
  "./icons/Brand/AtlasAI Black.png",
  "./icons/Brand/AtlasAI White.png",
  "./icons/Brand/Brand Black.png",
  "./icons/Brand/Brand White.png",
  "./icons/ModelIcons/Firefly 4.5.png",
  "./icons/ModelIcons/Forge 2.1.png",
  "./icons/ModelIcons/7.3 light.png",
  "./icons/ModelIcons/7.3 Pro.png",
  "./icons/ModelIcons/7.3 Ultra.png",
  "./icons/ModelIcons/7.3 Ultra Code.png",
  "./icons/ModelIcons/Poem 3.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => (k.startsWith("apex-chat-") || k.startsWith("atlas-chat-")) && k !== CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req=event.request;
  if(req.method!=="GET")return;

  const url=new URL(req.url);

  // Only cache Atlas app-shell files. WebLLM manages its own model cache.
  if(url.origin!==self.location.origin)return;

  if(req.mode==="navigate"){
    event.respondWith(
      fetch(req)
        .then(res=>{
          const copy=res.clone();
          caches.open(CACHE).then(cache=>cache.put(req,copy));
          return res;
        })
        .catch(async()=>await caches.match(req)||await caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached=>{
      if(cached)return cached;
      return fetch(req).then(res=>{
        if(res.ok){
          const copy=res.clone();
          caches.open(CACHE).then(cache=>cache.put(req,copy));
        }
        return res;
      });
    })
  );
});
