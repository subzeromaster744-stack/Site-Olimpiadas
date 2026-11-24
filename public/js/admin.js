/* Painel do organizador (link principal "/"): cria votações, mostra QR, acompanha ao vivo e expulsa. */
const RODADAS = ["1° Rodada", "2° Rodada", "3° Rodada", "Final"];
const TURNOS = ["1° Turno", "2° Turno", "3° Turno"];
const CATS = ["Segurança", "Quick Kaizen", "Standard Kaizen"];
const DEF_Q = ["Solução do problema", "Impacto nos indicadores", "Criatividade / inovação", "Facilidade de replicação", "Custo-benefício", "Clareza do relatório"];
const TOKEN_KEY = "olp_admin";
const USER_KEY = "olp_user";

const A = { token: localStorage.getItem(TOKEN_KEY), user: (() => { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } })(), polls: new Map(), sel: null, view: "poll", tab: "live", conn: "off", sock: null, loaded: false, flash: null, dupFrom: null };
const root = $("#root");
const fmt = (x) => (x ? x.toFixed(2).replace(".", ",") : "–");
const hhmm = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const voteUrl = (id) => `${location.origin}/v/${id}`;
const activeOf = (p) => p.participants.filter((x) => x.status === "active");

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: "Bearer " + A.token, ...(opts.body && typeof opts.body === "string" ? { "content-type": "application/json" } : {}), ...opts.headers } });
  if (r.status === 401) { logout(); throw new Error("Sessão expirada"); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || "Erro " + r.status);
  return b;
}

/* ---------- login / criar conta ---------- */
function logout() {
  localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
  A.token = null; A.user = null; A.sock?.close(); A.sock = null; A.loaded = false; A.polls.clear(); showLogin();
}
function showLogin(msg, mode = "in") {
  const reg = mode === "up";
  const name = h("input", { type: "text", placeholder: "Seu nome (como aparece no painel)", autocomplete: "name", maxlength: 60 });
  const user = h("input", { type: "text", placeholder: "Usuário", autocomplete: "username", autocapitalize: "none", spellcheck: false, autofocus: true });
  const pw = h("input", { type: "password", placeholder: reg ? "Senha (mínimo 6 caracteres)" : "Senha", autocomplete: reg ? "new-password" : "current-password" });
  const pw2 = h("input", { type: "password", placeholder: "Repita a senha", autocomplete: "new-password" });
  const code = h("input", { type: "text", placeholder: "Código de convite", autocomplete: "off", style: "display:none" });
  fetch("/api/auth/config").then((r) => r.json()).then((c) => { if (c.needsCode) code.style.display = ""; }).catch(() => {});
  const err = h("div", { class: "err-text" }, msg || "");
  const done = (b, fallbackName) => {
    A.token = b.token; A.user = { name: b.name || fallbackName };
    localStorage.setItem(TOKEN_KEY, b.token); localStorage.setItem(USER_KEY, JSON.stringify(A.user)); boot();
  };
  const post = async (url, body) => {
    const r = await fetch(url, { method: "POST", body: JSON.stringify(body) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || "Erro " + r.status);
    return b;
  };
  const go = async () => {
    err.textContent = ""; btn.disabled = true;
    try {
      const u = user.value.trim();
      if (reg) {
        if (pw.value !== pw2.value) throw new Error("As senhas não são iguais.");
        done(await post("/api/auth/register", { username: u, name: name.value, password: pw.value, code: code.value }));
      } else if (u.toLowerCase() === "admin") {
        done(await post("/api/admin/login", { password: pw.value }), "Administrador");
      } else {
        done(await post("/api/auth/login", { username: u, password: pw.value }));
      }
    } catch (e) { err.textContent = e.message || "Falha no login"; btn.disabled = false; }
  };
  const btn = h("button", { class: "btn", type: "button", style: "width:100%", onclick: go }, reg ? "Criar conta e entrar" : "Entrar");
  for (const i of [name, user, pw, pw2, code]) i.addEventListener("keydown", (e) => e.key === "Enter" && go());
  const tab = (m, label) => h("button", { type: "button", class: mode === m ? "on" : "", onclick: () => showLogin("", m) }, label);
  root.replaceChildren(h("div", { class: "card login" },
    h("div", { class: "logo" }, "🏅"), h("h1", {}, "Painel de votações"),
    h("p", { class: "small", style: "margin:0 0 14px" }, "Crie sua conta de organizador para montar formulários, gerar QR Codes e acompanhar as respostas ao vivo."),
    h("div", { class: "seg" }, tab("in", "Entrar"), tab("up", "Criar conta")),
    h("div", { class: "stack" }, ...(reg ? [name, user, pw, pw2, code] : [user, pw])),
    err, h("div", { style: "margin-top:12px" }, btn),
    h("p", { class: "small", style: "margin:16px 0 0;text-align:center" }, "Quem vai apenas votar não precisa de conta: basta escanear o QR Code.")));
}

/* ---------- tempo real ---------- */
const editing = (id) => A.view === "new" || (A.view === "poll" && A.tab === "config" && A.sel === id);
function connect() {
  A.sock = liveSocket(() => `/ws/admin?token=${encodeURIComponent(A.token)}`, {
    onstatus: (s) => { A.conn = s; renderBar(); },
    onmessage: (m) => {
      if (m.t === "init") {
        A.polls = new Map(m.polls.map((p) => [p.id, p])); A.loaded = true;
        if (!A.sel || !A.polls.has(A.sel)) A.sel = m.polls[0]?.id || null;
        if (editing(A.sel)) { renderSide(); renderBar(); } else renderAll();
      } else if (m.t === "poll") {
        A.polls.set(m.poll.id, m.poll);
        if (editing(m.poll.id)) { renderSide(); renderBar(); } else renderAll();
      } else if (m.t === "live") {
        const p = A.polls.get(m.poll); if (!p) return;
        p.participants = m.participants; p.results = m.results;
        renderSide(); renderBar();
        if (A.sel === m.poll && A.view === "poll") { renderHead(); if (["live", "resultados"].includes(A.tab)) renderTab(); }
      } else if (m.t === "deleted") {
        A.polls.delete(m.poll);
        if (A.sel === m.poll) { A.sel = A.polls.keys().next().value || null; A.view = "poll"; A.tab = "live"; }
        renderAll();
      }
    },
  });
}
function boot() { A.view = "poll"; layout(); connect(); }

/* ---------- layout ---------- */
function layout() {
  root.replaceChildren(h("div", { class: "adm" }, h("div", { class: "bar", id: "bar" }),
    h("div", { class: "layout" }, h("aside", { class: "card side", id: "side" }), h("section", { class: "card main", id: "main" }))));
  renderAll();
}
function renderAll() { renderBar(); renderSide(); renderMain(); }
function renderBar() {
  const bar = $("#bar"); if (!bar) return;
  const online = [...A.polls.values()].reduce((n, p) => n + activeOf(p).filter((x) => x.online).length, 0);
  bar.replaceChildren(h("h1", {}, h("span", {}, "🏅 "), "Painel de votações"),
    h("div", { style: "display:flex;gap:14px;align-items:center" },
      h("span", { class: "conn " + A.conn }, h("i"), A.conn === "on" ? `ao vivo · ${online} online` : "reconectando…"),
      A.user ? h("span", { class: "who" }, "👤 " + A.user.name) : null,
      h("button", { class: "btn ghost sm", type: "button", onclick: logout }, "Sair")));
}
function renderSide() {
  const side = $("#side"); if (!side) return;
  const ul = h("ul", { class: "plist" });
  for (const p of A.polls.values()) {
    const on = activeOf(p).filter((x) => x.online).length;
    ul.append(h("li", {}, h("button", { type: "button", class: p.id === A.sel && A.view === "poll" ? "on" : "", onclick: () => { A.sel = p.id; A.view = "poll"; A.tab = "live"; renderAll(); } },
      h("span", { class: "t" }, p.title),
      h("span", { class: "m" }, h("span", { class: "dot " + (on ? "on" : "") }), `${on} online · ${activeOf(p).length} participantes`, p.status === "closed" ? h("span", { class: "chip closed" }, "encerrada") : null))));
  }
  side.replaceChildren(
    h("button", { class: "btn", type: "button", style: "width:100%", onclick: () => { A.view = "new"; A.dupFrom = null; renderAll(); } }, "＋ Criar formulário"),
    h("h3", { style: "margin-top:18px" }, "Seus formulários"),
    A.loaded ? (A.polls.size ? ul : h("p", { class: "small" }, "Você ainda não criou nenhum.")) : h("p", { class: "small" }, "Carregando…"));
}
function renderMain() {
  const main = $("#main"); if (!main) return;
  if (A.view === "new") { main.replaceChildren(formView(null, { from: A.dupFrom })); return; }
  const p = A.polls.get(A.sel);
  if (!p) {
    main.replaceChildren(!A.loaded ? h("div", { class: "empty" }, "Carregando…") : welcome());
    return;
  }
  main.replaceChildren(h("div", { id: "head" }), h("div", { class: "tabs", id: "tabs" }), h("div", { id: "tab" }));
  renderHead(); renderTabs(); renderTab();
}
function welcome() {
  const step = (n, t, d) => h("div", { class: "wstep" }, h("div", { class: "wn" }, n), h("div", {}, h("b", {}, t), h("div", { class: "small" }, d)));
  return h("div", { class: "welcome" }, h("div", { class: "logo" }, "🏅"), h("h2", {}, "Bem-vindo! Vamos criar o primeiro formulário"),
    h("p", { class: "small", style: "max-width:520px;margin:0 auto 22px" }, "É rápido: você monta o formulário, mostra o QR Code e acompanha tudo em tempo real."),
    h("div", { class: "wsteps" }, step("1", "Crie o formulário", "Rodada, categoria, turno, seções com imagem e perguntas."),
      step("2", "Mostre o QR Code", "Quem escanear informa o nome e já pode votar."),
      step("3", "Acompanhe ao vivo", "Veja quem entrou, as médias e expulse quem não for convidado.")),
    h("button", { class: "btn", type: "button", style: "margin-top:24px;font-size:17px;padding:14px 30px", onclick: () => { A.view = "new"; renderAll(); } }, "＋ Criar formulário"));
}
function renderHead() {
  const head = $("#head"); const p = A.polls.get(A.sel); if (!head || !p) return;
  const act = activeOf(p), online = act.filter((x) => x.online).length;
  const closed = p.status === "closed";
  head.replaceChildren(
    h("div", { class: "head2" }, h("div", {}, h("h2", {}, p.title), h("span", { class: "chip " + (closed ? "closed" : "") }, closed ? "Encerrada – não aceita novos votos" : "Aberta para votação")),
      h("button", { class: "btn ghost sm", type: "button", onclick: () => api(`/api/polls/${p.id}`, { method: "PUT", body: JSON.stringify({ status: closed ? "open" : "closed" }) }).catch((e) => alert(e.message)) }, closed ? "Reabrir" : "Encerrar votação")),
    h("div", { class: "kpis" },
      kpi(online, "online agora", "on"), kpi(act.length, "participantes"), kpi(p.results.respondents, "já votaram")));
}
const kpi = (n, l, cls) => h("div", { class: "kpi " + (cls || "") }, h("b", {}, String(n)), h("span", {}, l));
function renderTabs() {
  const t = $("#tabs"); if (!t) return;
  const tabs = [["live", "👥 Ao vivo"], ["resultados", "📊 Resultados"], ["qr", "🔳 QR Code"], ["config", "⚙️ Configurar"]];
  t.replaceChildren(...tabs.map(([k, l]) => h("button", { type: "button", class: A.tab === k ? "on" : "", onclick: () => { A.tab = k; renderTabs(); renderTab(); } }, l)));
}
function renderTab() {
  const el = $("#tab"); const p = A.polls.get(A.sel); if (!el || !p) return;
  el.replaceChildren(A.tab === "live" ? tabLive(p) : A.tab === "resultados" ? tabResults(p) : A.tab === "qr" ? tabQR(p) : configTab(p));
}

/* ---------- ao vivo (participantes) ---------- */
function tabLive(p) {
  const active = activeOf(p).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name, "pt-BR"));
  const kicked = p.participants.filter((x) => x.status === "kicked");
  const w = h("div", {});
  if (!active.length) {
    w.append(h("div", { class: "empty" }, h("div", { style: "font-size:42px" }, "📲"), h("b", {}, "Ninguém entrou ainda"), h("div", { class: "small", style: "margin:6px 0 14px" }, "Mostre o QR Code para os participantes. Quem entrar aparece aqui na hora."),
      h("button", { class: "btn", type: "button", onclick: () => { A.tab = "qr"; renderTabs(); renderTab(); } }, "Ver QR Code")));
  } else {
    w.append(h("p", { class: "small", style: "margin:0 0 10px" }, "Não reconhece alguém? ", h("b", {}, "Expulsar"), " desconecta a pessoa e bloqueia o acesso. ", h("b", {}, "Anular respostas"), " mantém a pessoa, mas as notas dela deixam de contar (dá para restaurar)."));
    const tb = h("tbody", {});
    for (const x of active) {
      tb.append(h("tr", { class: x.annulled ? "annulled" : "" },
        h("td", {}, h("span", { class: "dot " + (x.online ? "on" : "") }), " ", x.online ? "Online" : "Offline"),
        h("td", {}, h("b", {}, x.name), x.annulled ? h("span", { class: "chip closed", style: "margin-left:8px" }, "respostas anuladas") : null), h("td", {}, hhmm(x.joined_at)),
        h("td", { style: "min-width:140px" }, h("div", { class: "pbar" }, h("i", { style: `width:${Math.round((x.answered / x.total) * 100)}%` })), h("span", { class: "small" }, `${x.answered}/${x.total} respostas`)),
        h("td", { class: "c acts" },
          x.annulled
            ? h("button", { class: "btn ghost sm", type: "button", onclick: () => act(p, x, "restore") }, "Restaurar respostas")
            : h("button", { class: "btn ghost sm", type: "button", onclick: () => annul(p, x) }, "Anular respostas"),
          h("button", { class: "btn danger sm", type: "button", onclick: () => kick(p, x) }, "Expulsar"))));
    }
    w.append(h("div", { style: "overflow-x:auto" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, ["Situação", "Nome", "Entrou às", "Progresso", ""].map((c) => h("th", {}, c)))), tb)));
  }
  if (kicked.length) {
    w.append(h("div", { class: "head2", style: "margin:24px 0 8px;align-items:center" },
        h("h3", { style: "margin:0;color:var(--err)" }, `Expulsos (${kicked.length})`),
        h("button", { class: "btn danger sm", type: "button", onclick: () => deleteKicked(p, kicked) }, "🗑 Apagar todos")),
      h("table", { class: "t" }, h("tbody", {}, kicked.map((x) => h("tr", {}, h("td", {}, h("b", {}, x.name)), h("td", { class: "small" }, "Bloqueado nesta votação"),
        h("td", { class: "c acts" },
          h("button", { class: "btn ghost sm", type: "button", onclick: () => act(p, x, "unkick") }, "Readmitir"),
          h("button", { class: "btn danger sm", type: "button", onclick: () => removeOne(p, x) }, "🗑 Apagar")))))));
  }
  return w;
}
const act = (p, x, action) => api(`/api/polls/${p.id}/participants/${x.id}/${action}`, { method: "POST" }).catch((e) => alert(e.message));
function annul(p, x) {
  if (!confirm(`Anular as respostas de “${x.name}”?\n\nAs notas ficam guardadas, mas deixam de contar nos resultados (inclusive as próximas). Você pode restaurar depois.`)) return;
  act(p, x, "annul");
}
function removeOne(p, x) {
  if (!confirm(`Apagar “${x.name}” da lista de expulsos?\n\nO nome deixa de ser bloqueado e as respostas dessa pessoa são apagadas de vez.`)) return;
  api(`/api/polls/${p.id}/participants/${x.id}`, { method: "DELETE" }).catch((e) => alert(e.message));
}
function deleteKicked(p, list) {
  if (!confirm(`Apagar todos os ${list.length} nomes da lista de expulsos?\n\nOs nomes deixam de ser bloqueados e as respostas dessas pessoas são apagadas de vez.`)) return;
  api(`/api/polls/${p.id}/kicked`, { method: "DELETE" }).catch((e) => alert(e.message));
}
function kick(p, x) {
  if (!confirm(`Expulsar “${x.name}” desta votação?\n\nOs votos dessa pessoa deixam de contar e o nome fica bloqueado.`)) return;
  api(`/api/polls/${p.id}/participants/${x.id}/kick`, { method: "POST" }).catch((e) => alert(e.message));
}

/* ---------- resultados ---------- */
function tabResults(p) {
  const head = h("tr", {}, h("th", {}, "Pergunta"), p.sections.map((s, i) => h("th", { class: "c" }, s.title || `Seção ${i + 1}`)));
  const body = h("tbody", {}, p.questions.map((q, j) => h("tr", {}, h("td", {}, q), p.sections.map((_, i) => { const c = p.results.cells[`${i}_${j}`]; return h("td", { class: "c" }, c ? fmt(c.avg) : "–"); }))));
  const foot = h("tr", {}, h("td", {}, h("b", {}, "Média do projeto")), p.sections.map((_, i) => {
    let s = 0, n = 0; p.questions.forEach((_, j) => { const c = p.results.cells[`${i}_${j}`]; if (c) { s += c.avg * c.n; n += c.n; } });
    return h("td", { class: "c" }, h("b", {}, fmt(n ? s / n : 0)));
  }));
  return h("div", {},
    h("div", { class: "head2" }, h("p", { class: "small", style: "margin:0" }, `${p.results.respondents} participante(s) com notas · atualiza sozinho · votos de expulsos e de respostas anuladas não contam.`),
      h("button", { class: "btn ghost sm", type: "button", onclick: () => exportCsv(p) }, "⬇ Baixar CSV")),
    h("div", { style: "overflow-x:auto" }, h("table", { class: "t" }, h("thead", {}, head), body, h("tfoot", {}, foot))),
    null);
}
async function exportCsv(p) {
  try {
    const r = await fetch(`/api/polls/${p.id}/export.csv`, { headers: { authorization: "Bearer " + A.token } });
    if (!r.ok) throw new Error("Falha ao exportar");
    const a = h("a", { href: URL.createObjectURL(await r.blob()), download: `votos-${p.id}.csv` }); document.body.append(a); a.click(); a.remove();
  } catch (e) { alert(e.message); }
}

/* ---------- QR code ---------- */
function drawQR(canvas, p) {
  const url = voteUrl(p.id);
  const qr = qrcode(0, "M"); qr.addData(url); qr.make();
  const n = qr.getModuleCount(), W = 720, pad = 48, qs = W - pad * 2, cell = Math.floor(qs / n), size = cell * n, off = Math.round((W - size) / 2);
  const ctx = canvas.getContext("2d");
  const lines = []; const words = p.title.split(" "); let cur = "";
  ctx.font = "700 40px 'Segoe UI',Arial,sans-serif";
  for (const wd of words) { if (ctx.measureText((cur + " " + wd).trim()).width > W - 80) { lines.push(cur); cur = wd; } else cur = (cur + " " + wd).trim(); }
  if (cur) lines.push(cur);
  const top = 40 + lines.length * 48 + 20, H = top + size + 110;
  canvas.width = W; canvas.height = H;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#0f4c75"; ctx.textAlign = "center"; ctx.font = "700 40px 'Segoe UI',Arial,sans-serif";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, 62 + i * 48));
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, top + r * cell, cell, cell);
  ctx.fillStyle = "#1f3d57"; ctx.font = "600 26px 'Segoe UI',Arial,sans-serif"; ctx.fillText("Aponte a câmera para votar", W / 2, top + size + 44);
  ctx.fillStyle = "#5d6b78"; ctx.font = "20px 'Segoe UI',Arial,sans-serif"; ctx.fillText(url, W / 2, top + size + 80);
}
function tabQR(p) {
  const canvas = h("canvas", { style: "width:min(100%,420px)" });
  drawQR(canvas, p);
  const url = voteUrl(p.id), inp = h("input", { type: "text", readonly: true, value: url });
  inp.addEventListener("focus", () => inp.select());
  const copy = h("button", { class: "btn ghost sm", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(url); } catch { inp.select(); document.execCommand("copy"); } copy.textContent = "Copiado ✓"; setTimeout(() => (copy.textContent = "Copiar"), 1500); } }, "Copiar");
  const flash = A.flash === "created" ? h("div", { class: "success" }, "✅ Formulário criado! Mostre este QR Code para os participantes (ou envie o link).") : null;
  A.flash = null;
  return h("div", {}, flash, h("div", { class: "qrwrap" }, canvas, h("div", { class: "qrside" },
    h("h3", { style: "margin:0 0 4px;color:var(--title)" }, "Link para votar"),
    h("div", { class: "linkbox" }, inp, copy),
    h("div", { class: "actions", style: "margin-top:0" },
      h("button", { class: "btn", type: "button", onclick: () => canvas.toBlob((b) => { const a = h("a", { href: URL.createObjectURL(b), download: `qr-${p.id}.png` }); document.body.append(a); a.click(); a.remove(); }) }, "⬇ Baixar PNG"),
      h("button", { class: "btn ghost", type: "button", onclick: () => window.print() }, "🖨 Imprimir")),
    h("ul", { class: "tips" }, h("li", {}, "Quem escanear só consegue responder este formulário."), h("li", {}, "Antes de começar, a pessoa precisa digitar o nome."), h("li", {}, "Você vê quem entrou na aba “Ao vivo” e pode expulsar.")),
    p.status === "closed" ? h("div", { class: "notice" }, "Esta votação está encerrada: ninguém novo consegue entrar.") : null)));
}

/* ---------- formulário: criar (em passos) / configurar ---------- */
function resizeImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = async () => {
      let maxW = 1600, q = 0.85;
      for (let t = 0; t < 14; t++) {
        const sc = Math.min(1, maxW / im.width), c = document.createElement("canvas");
        c.width = Math.round(im.width * sc); c.height = Math.round(im.height * sc);
        const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height);
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
        if (blob.size < 1_500_000) { URL.revokeObjectURL(url); return res(blob); }
        if (q > 0.55) q -= 0.1; else maxW = Math.round(maxW * 0.8);
      }
      rej(new Error("Imagem muito grande"));
    };
    im.onerror = () => rej(new Error("Arquivo de imagem inválido"));
    im.src = url;
  });
}

function chips(items, get, set, after) {
  const box = h("div", { class: "chips", role: "radiogroup" });
  const draw = () => box.replaceChildren(...items.map((i) => h("button", { type: "button", role: "radio", "aria-checked": String(get() === i), class: "chipbtn" + (get() === i ? " on" : ""), onclick: () => { set(i); draw(); after?.(); } }, i)));
  draw(); box.redraw = draw; return box;
}
const fmtSize = (n) => (!n ? "" : n >= 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

/* PDF → imagem da 1ª página (pdf.js carregado só quando preciso) */
let pdfjsReady;
function loadPdfjs() {
  return (pdfjsReady ||= new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = "/vendor/pdf.min.js";
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js"; res(window.pdfjsLib); };
    s.onerror = () => { pdfjsReady = null; rej(new Error("Não foi possível carregar o leitor de PDF.")); };
    document.head.append(s);
  }));
}
async function pdfToImage(file) {
  const lib = await loadPdfjs();
  let doc;
  try { doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }
  catch { throw new Error("Não foi possível ler este PDF (protegido por senha ou corrompido)."); }
  const page = await doc.getPage(1), base = page.getViewport({ scale: 1 });
  let width = 1600, q = 0.85;
  for (let t = 0; t < 12; t++) {
    const vp = page.getViewport({ scale: Math.min(4, width / base.width) });
    const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp }).promise;
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
    if (blob.size < 1_500_000) return { blob, pages: doc.numPages };
    if (q > 0.55) q -= 0.1; else width = Math.round(width * 0.8);
  }
  throw new Error("Não foi possível gerar a prévia do PDF.");
}
const configTab = (p) => formView(p);

function formView(p, opts = {}) {
  const edit = !!p, base = p || opts.from || null, dup = !edit && !!opts.from;
  const v = { rodada: base?.rodada || RODADAS[0], categoria: base?.categoria || CATS[0], turno: base?.turno ?? TURNOS[0], title: edit ? p.title : "", bannerBig: base?.banner?.big ?? "10", bannerSub: base?.banner?.sub ?? "Anos · Olimpíadas" };
  const bn = { img: base?.banner?.img || null, file: null, removed: false };
  const mkDraft = (s) => ({ title: s?.title || "", img: s?.img || null, file: null, removed: false, pdf: null, pdfUrl: s?.pdf || null, pdfName: s?.pdfName || null, pdfSize: s?.pdfSize || null, pdfPages: null, pdfRemoved: false });
  const drafts = (base?.sections || Array.from({ length: 4 }, () => null)).map(mkDraft);
  const qs = h("textarea", { rows: "8", placeholder: "Uma pergunta por linha" }); qs.value = (base?.questions || DEF_Q).join("\n");

  /* bloco 1: dados */
  const preview = h("div", { class: "previewline" });
  const upd = () => { const t = [v.rodada, v.categoria, v.turno].filter(Boolean).join(" · "); preview.replaceChildren(h("small", {}, "Como vai aparecer para o participante"), h("b", {}, v.title.trim() || t || "—")); };
  const cat = h("input", { type: "text", maxlength: "40", value: v.categoria, placeholder: "Ex.: Segurança" });
  cat.addEventListener("input", () => { v.categoria = cat.value; catChips.redraw?.(); upd(); });
  const catChips = chips(CATS, () => v.categoria, (c) => { v.categoria = c; cat.value = c; }, upd);
  const title = h("input", { type: "text", maxlength: "120", value: v.title, placeholder: "Deixe vazio para usar o padrão acima" });
  title.addEventListener("input", () => { v.title = title.value; upd(); });
  const turnoChips = chips([...TURNOS, "Sem turno"], () => (v.turno === "" ? "Sem turno" : v.turno), (t) => (v.turno = t === "Sem turno" ? "" : t), upd);
  /* banner (topo da página de votação) */
  const bpv = h("div", { class: "bannerpv" });
  const drawBanner = () => {
    const src = bn.file ? URL.createObjectURL(bn.file) : bn.removed ? null : bn.img;
    bpv.replaceChildren(bannerEl({ big: v.bannerBig, sub: v.bannerSub, img: src }));
  };
  const bigIn = h("input", { type: "text", maxlength: "12", value: v.bannerBig, placeholder: "Ex.: 10" });
  const subIn = h("input", { type: "text", maxlength: "40", value: v.bannerSub, placeholder: "Ex.: Anos · Olimpíadas" });
  bigIn.addEventListener("input", () => { v.bannerBig = bigIn.value; drawBanner(); });
  subIn.addEventListener("input", () => { v.bannerSub = subIn.value; drawBanner(); });
  const bfile = h("input", { type: "file", accept: "image/*", id: "bfile", class: "hidden" });
  bfile.addEventListener("change", async () => {
    const f = bfile.files[0]; if (!f) return;
    try { bn.file = await resizeImage(f); bn.removed = false; } catch (e) { alert(e.message); }
    bfile.value = ""; drawBanner();
  });
  const bannerField = h("div", { class: "field" }, h("label", { class: "lbl" }, "Banner do topo"),
    h("div", { class: "hint", style: "margin:0 0 8px" }, "Edite os textos ou use sua própria imagem no lugar (ideal: formato de faixa, ex.: 1200 × 690)."),
    bpv,
    h("div", { class: "grid2" }, h("div", {}, h("label", { class: "lbl sm" }, "Texto grande"), bigIn), h("div", {}, h("label", { class: "lbl sm" }, "Texto pequeno"), subIn)),
    h("div", { style: "display:flex;gap:10px;margin-top:8px;flex-wrap:wrap" },
      h("label", { class: "btn ghost sm", for: "bfile" }, "🖼 Usar uma imagem"), bfile,
      h("button", { class: "btn ghost sm", type: "button", onclick: () => { bn.file = null; bn.removed = true; drawBanner(); } }, "Voltar ao banner de texto"),
      h("button", { class: "btn ghost sm", type: "button", onclick: () => { v.bannerBig = bigIn.value = "10"; v.bannerSub = subIn.value = "Anos · Olimpíadas"; drawBanner(); } }, "Restaurar padrão")));
  drawBanner();
  const b1 = h("div", { class: "block" },
    h("div", { class: "field" }, h("label", { class: "lbl" }, "Rodada"), chips(RODADAS, () => v.rodada, (r) => (v.rodada = r), upd)),
    h("div", { class: "field" }, h("label", { class: "lbl" }, "Categoria"), cat, catChips, h("div", { class: "hint" }, "Escolha uma sugestão ou digite outra.")),
    h("div", { class: "field" }, h("label", { class: "lbl" }, "Turno"), turnoChips),
    h("div", { class: "field" }, h("label", { class: "lbl" }, "Título (opcional)"), title), preview, bannerField);
  upd();

  /* bloco 2: seções */
  const list = h("div", {});
  const drawSecs = () => list.replaceChildren(...drafts.map((d, i) => {
    const t = h("input", { type: "text", maxlength: "120", placeholder: "Nome do projeto (ex.: Usinagem de Eixos A)", value: d.title }); t.addEventListener("input", () => (d.title = t.value));
    const pv = h("div", { class: "thumb" }), badge = h("div", { class: "pdfbadge" });
    const showPv = () => {
      pv.replaceChildren(); const src = d.file ? URL.createObjectURL(d.file) : d.removed ? null : d.img;
      pv.append(src ? h("img", { src, alt: "" }) : h("span", {}, "Sem imagem"));
      const hasPdf = d.pdf || (d.pdfUrl && !d.pdfRemoved);
      badge.replaceChildren(); badge.classList.toggle("hidden", !hasPdf);
      if (hasPdf) badge.append("📄 ", h("b", {}, d.pdf ? d.pdf.name : d.pdfName || "documento.pdf"), ` · ${fmtSize(d.pdf ? d.pdf.size : d.pdfSize)}`, d.pdfPages ? ` · ${d.pdfPages} pág.` : "", h("span", { class: "small" }, " — o participante vê a 1ª página e pode abrir o PDF completo"));
    };
    const f = h("input", { type: "file", accept: "image/*,application/pdf,.pdf", id: `f${i}`, class: "hidden" });
    f.addEventListener("change", async () => {
      const file = f.files[0]; if (!file) return;
      try {
        if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          if (file.size > 20 * 1024 * 1024) throw new Error("O PDF tem mais de 20 MB.");
          pv.replaceChildren(h("span", {}, "Gerando prévia…"));
          const { blob, pages } = await pdfToImage(file);
          d.file = blob; d.pdf = file; d.pdfPages = pages; d.pdfRemoved = false; d.removed = false;
        } else {
          d.file = await resizeImage(file); d.removed = false;
          d.pdf = null; d.pdfPages = null; if (d.pdfUrl) d.pdfRemoved = true;   // trocar por imagem comum tira o PDF antigo
        }
      } catch (e) { alert(e.message); }
      f.value = ""; showPv();
    });
    showPv();
    return h("div", { class: "secrow" }, h("div", { class: "secnum" }, String(i + 1)),
      h("div", { class: "secbody" }, t, h("div", { class: "r" }, h("label", { class: "btn ghost sm", for: `f${i}` }, "📎 Imagem ou PDF"), f,
        h("button", { class: "btn ghost sm", type: "button", onclick: () => { d.file = null; d.removed = true; d.pdf = null; d.pdfPages = null; if (d.pdfUrl) d.pdfRemoved = true; f.value = ""; showPv(); } }, "Remover")), badge),
      pv);
  }));
  drawSecs();
  const b2 = h("div", { class: "block" }, h("p", { class: "hint", style: "margin-top:0" }, "Cada seção aparece como uma página para o participante, começando pela imagem do projeto."), list,
    h("div", { class: "r", style: "display:flex;gap:10px;margin-top:6px" },
      h("button", { class: "btn ghost sm", type: "button", onclick: () => { if (drafts.length < 12) { drafts.push(mkDraft(null)); drawSecs(); } } }, "＋ Adicionar seção"),
      h("button", { class: "btn ghost sm", type: "button", onclick: () => { if (drafts.length > 1 && confirm("Remover a última seção? Os votos dela serão apagados ao salvar.")) { drafts.pop(); drawSecs(); } } }, "− Remover última")));

  /* bloco 3: perguntas */
  const b3 = h("div", { class: "block" }, h("p", { class: "hint", style: "margin-top:0" }, "As mesmas perguntas valem para todas as seções. Cada uma recebe nota de 1 a 5 estrelas."), qs);

  const err = h("div", { class: "err-text" });
  const save = async (btn, label) => {
    err.textContent = "";
    if (!v.categoria.trim()) { err.textContent = "Informe a categoria."; return; }
    if (!qs.value.split("\n").some((x) => x.trim())) { err.textContent = "Escreva ao menos uma pergunta."; return; }
    btn.disabled = true; btn.textContent = "Salvando…";
    try {
      const body = JSON.stringify({ rodada: v.rodada, categoria: v.categoria, turno: v.turno, title: v.title, bannerBig: v.bannerBig, bannerSub: v.bannerSub, sections: drafts.map((d) => ({ title: d.title })), questions: qs.value.split("\n") });
      const poll = edit ? (await api(`/api/polls/${p.id}`, { method: "PUT", body }), p) : await api("/api/polls", { method: "POST", body });
      const putBanner = (blob) => api(`/api/polls/${poll.id}/image/-1`, { method: "PUT", body: blob, headers: { "content-type": blob.type || "image/jpeg" } });
      if (bn.file) await putBanner(bn.file);
      else if (bn.removed && bn.img && edit) await api(`/api/polls/${poll.id}/image/-1`, { method: "DELETE" });
      else if (dup && bn.img && !bn.removed) await putBanner(await (await fetch(bn.img)).blob());
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i], put = (blob) => api(`/api/polls/${poll.id}/image/${i}`, { method: "PUT", body: blob, headers: { "content-type": blob.type || "image/jpeg" } });
        if (d.file) await put(d.file);
        else if (d.removed && d.img && edit) await api(`/api/polls/${poll.id}/image/${i}`, { method: "DELETE" });
        else if (dup && d.img && !d.removed) await put(await (await fetch(d.img)).blob());
        const putPdf = (blob, name) => api(`/api/polls/${poll.id}/pdf/${i}`, { method: "PUT", body: blob, headers: { "content-type": "application/pdf", "x-filename": encodeURIComponent(name) } });
        if (d.pdf) await putPdf(d.pdf, d.pdf.name);
        else if (d.pdfRemoved && d.pdfUrl && edit) await api(`/api/polls/${poll.id}/pdf/${i}`, { method: "DELETE" });
        else if (dup && d.pdfUrl && !d.pdfRemoved) await putPdf(await (await fetch(d.pdfUrl)).blob(), d.pdfName || "documento.pdf");
      }
      A.sel = poll.id; A.view = "poll";
      if (edit) {
        // o formulário continua aberto: marca o que já foi salvo para não reenviar nem perder a prévia
        if (bn.file) { bn.img = URL.createObjectURL(bn.file); bn.file = null; } else if (bn.removed) { bn.img = null; bn.removed = false; }
        for (const d of drafts) {
          if (d.file) { d.img = URL.createObjectURL(d.file); d.file = null; } else if (d.removed) { d.img = null; d.removed = false; }
          if (d.pdf) { d.pdfUrl = "salvo"; d.pdfName = d.pdf.name; d.pdfSize = d.pdf.size; d.pdf = null; } else if (d.pdfRemoved) { d.pdfUrl = null; d.pdfRemoved = false; }
        }
        drawSecs();
        A.tab = "config"; const bt = $("#savedmsg"); btn.disabled = false; btn.textContent = label; if (bt) { bt.textContent = "✓ Alterações salvas"; setTimeout(() => (bt.textContent = ""), 2500); } renderHead(); renderSide(); }
      else { A.tab = "qr"; A.flash = "created"; renderAll(); }
    } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = label; }
  };

  if (edit) {
    const sv = h("button", { class: "btn", type: "button" }, "Salvar alterações"); sv.addEventListener("click", () => save(sv, "Salvar alterações"));
    const closed = p.status === "closed";
    return h("div", {},
      h("h3", { class: "bh" }, "1 · Dados"), b1, h("h3", { class: "bh" }, "2 · Seções e imagens"), b2, h("h3", { class: "bh" }, "3 · Perguntas"), b3, err,
      h("div", { class: "actions" }, sv, h("span", { id: "savedmsg", class: "small" }), h("span", { style: "flex:1" }),
        h("button", { class: "btn ghost", type: "button", onclick: () => { A.dupFrom = p; A.view = "new"; renderAll(); } }, "⧉ Duplicar (ex.: outro turno)"),
        h("button", { class: "btn danger", type: "button", onclick: () => { if (confirm(`Excluir “${p.title}”?\n\nTodos os votos e participantes serão apagados. Esta ação não pode ser desfeita.`)) api(`/api/polls/${p.id}`, { method: "DELETE" }).catch((e) => alert(e.message)); } }, "Excluir")));
  }

  /* assistente em 3 passos */
  const names = ["Dados", "Seções e imagens", "Perguntas"], blocks = [b1, b2, b3];
  let step = 0;
  const wrap = h("div", {});
  const draw = () => {
    wrap.replaceChildren(...[
      h("h2", { style: "margin:0 0 4px" }, dup ? "Duplicar formulário" : "Novo formulário"),
      dup ? h("p", { class: "small", style: "margin:0 0 6px" }, `Copiando de “${base.title}”. Ajuste o que mudou (por exemplo, o turno).`) : null,
      h("ol", { class: "stepper" }, names.map((n, i) => h("li", { class: i === step ? "on" : i < step ? "done" : "", onclick: () => { if (i <= step) { step = i; draw(); } } }, h("span", {}, i < step ? "✓" : String(i + 1)), n))),
      blocks[step], err,
      h("div", { class: "nav", style: "margin-top:20px" },
        step > 0 ? h("button", { class: "btn ghost", type: "button", onclick: () => { err.textContent = ""; step--; draw(); } }, "Voltar") : h("button", { class: "btn ghost", type: "button", onclick: () => { A.view = "poll"; renderAll(); } }, "Cancelar"),
        step < 2 ? h("button", { class: "btn", type: "button", onclick: () => { if (step === 0 && !v.categoria.trim()) { err.textContent = "Informe a categoria."; return; } err.textContent = ""; step++; draw(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, "Continuar")
          : (() => { const b = h("button", { class: "btn", type: "button" }, "✓ Criar formulário e gerar QR"); b.addEventListener("click", () => save(b, "✓ Criar formulário e gerar QR")); return b; })())].filter(Boolean));
  };
  draw();
  return wrap;
}

/* ---------- início ---------- */
if (A.token) boot(); else showLogin();
