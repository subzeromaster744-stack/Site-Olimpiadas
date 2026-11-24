/* utilidades compartilhadas (sem dependências) */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const $ = (s, r = document) => r.querySelector(s);
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="M12 2.8l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.7l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95L12 2.8z"/></svg>';
const wsUrl = (path) => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + path;

/* WebSocket com reconexão automática e batimento (ping) */
function liveSocket(path, { onmessage, onstatus }) {
  let ws, tries = 0, timer, ping, stopped = false;
  const open = () => {
    ws = new WebSocket(wsUrl(path()));
    ws.onopen = () => { tries = 0; onstatus?.("on"); clearInterval(ping); ping = setInterval(() => ws.readyState === 1 && ws.send('{"t":"ping"}'), 25000); };
    ws.onmessage = (e) => { try { onmessage(JSON.parse(e.data)); } catch {} };
    ws.onclose = (e) => {
      clearInterval(ping); onstatus?.("off");
      if (stopped || (e.code >= 4400 && e.code < 4500)) return;
      timer = setTimeout(open, Math.min(1000 * 2 ** tries++, 10000));
    };
  };
  open();
  return {
    send: (o) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; },
    close: () => { stopped = true; clearTimeout(timer); clearInterval(ping); ws?.close(); },
  };
}

/* banner do topo da página de votação (texto editável ou imagem) */
function bannerEl(b) {
  if (b?.img) return h("div", { class: "banner pic" }, h("img", { src: b.img, alt: "" }));
  return h("div", { class: "banner" }, b?.big ? h("div", { class: "big" }, b.big) : null, b?.sub ? h("div", { class: "sub" }, b.sub) : null);
}
