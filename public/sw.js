/* O site não é mais um app instalável (PWA). Este arquivo existe só para limpar o que navegadores
   que já tinham o app registrado guardaram: apaga o cache e se desregistra. Pode ser removido depois. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
  })());
});
