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

/* ---------- estilos (temas) do formulário ---------- */
const THEMES = {
  azul: { label: "Azul (padrão)" },
  ouro: { label: "Preto e dourado (ano passado)" },
  custom: { label: "Personalizado" },
};
const _rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const _hex = (c) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const _mix = (a, b, t) => { const x = _rgb(a), y = _rgb(b); return _hex(x.map((v, i) => v + (y[i] - v) * t)); };
// devolve { vars, bg } para o tema; null = visual padrão (azul)
function themeVars(t) {
  if (!t || t.preset === "azul" || !t.preset) return null;
  const c = t.preset === "ouro" ? { accent: "#d4a017", bg: "#050505", dark: true } : t;
  const a = c.accent, dark = c.dark;
  const v = {
    "--accent": a, "--accent-d": _mix(a, "#000000", 0.25), "--teal": _mix(a, "#ffffff", dark ? 0.35 : 0.25),
    "--star": a, "--star-stroke": _mix(a, "#000000", 0.25), "--star-hov": _mix(a, "#ffffff", 0.5),
    "--banner-bg": dark ? `linear-gradient(160deg,#000,${_mix(a, "#000000", 0.82)})` : `linear-gradient(160deg,${_mix(a, "#000000", 0.3)},${a} 55%,${_mix(a, "#ffffff", 0.35)})`,
    "--big-bg": `linear-gradient(180deg,${_mix(a, "#ffffff", 0.6)},${a} 55%,${_mix(a, "#000000", 0.2)})`,
    "--banner-pic-bg": dark ? "#000" : _mix(a, "#000000", 0.3),
  };
  if (dark) Object.assign(v, {
    "--card": "#141414", "--right": "#0b0b0b", "--ink": "#f3ead2", "--title": _mix(a, "#ffffff", 0.3), "--muted": "#b3a888", "--muted-top": "#b3a888",
    "--line": "#3a3426", "--soft": "#231f17", "--field": "#1d1a14", "--fbd": "#4a4230", "--ghost-h": "#231f17", "--btn-ink": "#1a1200", "--num-ink": "#1a1200", "--star-off": "#8a8068",
  });
  else Object.assign(v, { "--title": _mix(a, "#000000", 0.45), "--ghost-h": _mix(a, "#ffffff", 0.9) });
  return { vars: v, bg: t.preset === "ouro" ? "linear-gradient(135deg,#000 0%,#14100a 60%,#241b06 100%)" : c.bg };
}
// aplica o tema em um elemento (a página inteira ou só uma prévia)
function applyTheme(el, t) {
  for (const k of [...el.style]) if (k.startsWith("--")) el.style.removeProperty(k);
  const th = themeVars(t);
  el.style.background = th ? th.bg : "";
  if (el === document.body && th) el.style.backgroundAttachment = "fixed";
  if (th) for (const [k, val] of Object.entries(th.vars)) el.style.setProperty(k, val);
}

/* contato de suporte (rodapé) */
const SUPPORT_EMAIL = "kevinca@weg.net";
const supportEl = () => h("footer", { class: "support" }, "Precisa de ajuda? Suporte: ", h("a", { href: "mailto:" + SUPPORT_EMAIL }, SUPPORT_EMAIL));
