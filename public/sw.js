/* Service worker: deixa o painel instalável e abre o "esqueleto" do site mesmo sem internet.
   Dados (API, WebSocket, imagens e PDFs das votações) NUNCA passam pelo cache. */
const CACHE = "olp-shell-v1";
const SHELL = ["/", "/css/app.css", "/js/common.js", "/js/admin.js", "/js/vote.js", "/v/", "/vendor/qrcode.js",
  "/icons/icon-192.png", "/icons/icon-512.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (/^\/(api|ws|img|pdf)\//.test(url.pathname) || url.pathname === "/sw.js") return;   // sempre direto na rede
  // rede primeiro (sempre a versão mais nova); sem internet usa a última cópia guardada
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") return (await caches.match(/^\/v\//.test(url.pathname) ? "/v/" : "/")) || Response.error();
      return Response.error();
    }));
});
