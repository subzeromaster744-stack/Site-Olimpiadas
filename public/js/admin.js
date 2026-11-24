/* Painel do administrador: /admin */
const RODADAS = ["1ª Rodada", "2ª Rodada", "3ª Rodada", "4ª Rodada"];
const TURNOS = ["1º Turno", "2º Turno", "3º Turno"];
const CATS = ["Segurança", "Qualidade", "Produtividade"];
const DEF_Q = ["Solução do problema", "Impacto nos indicadores", "Criatividade / inovação", "Facilidade de replicação", "Custo-benefício", "Clareza do relatório"];

const A = { token: sessionStorage.getItem("olp_admin"), polls: new Map(), sel: null, tab: "participantes", conn: "off", sock: null, loaded: false };
const root = $("#root");
const fmt = (x) => (x ? x.toFixed(2).replace(".", ",") : "–");
const hhmm = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const voteUrl = (id) => `${location.origin}/v/${id}`;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: "Bearer " + A.token, ...(opts.body && typeof opts.body === "string" ? { "content-type": "application/json" } : {}), ...opts.headers } });
  if (r.status === 401) { logout(); throw new Error("Sessão expirada"); }
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || "Erro " + r.status);
  return b;
}

/* ---------- login ---------- */
function logout() { sessionStorage.removeItem("olp_admin"); A.token = null; A.sock?.close(); A.sock = null; A.loaded = false; A.polls.clear(); showLogin(); }
function showLogin(msg) {
  const pw = h("input", { type: "password", placeholder: "Senha do administrador", autofocus: true, autocomplete: "current-password" });
  const err = h("div", { class: "err-text" }, msg || "");
  const go = async () => {
    err.textContent = ""; btn.disabled = true;
    try {
      const r = await fetch("/api/admin/login", { method: "POST", body: JSON.stringify({ password: pw.value }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      A.token = b.token; sessionStorage.setItem("olp_admin", b.token); boot();
    } catch (e) { err.textContent = e.message || "Falha no login"; btn.disabled = false; }
  };
  const btn = h("button", { class: "btn", type: "button", onclick: go }, "Entrar");
  pw.addEventListener("keydown", (e) => e.key === "Enter" && go());
  root.replaceChildren(h("div", { class: "card login" }, h("h1", {}, "Administração"), h("p", { class: "small", style: "margin:0 0 16px" }, "Área restrita ao organizador."), pw, err, h("div", { style: "margin-top:12px" }, btn)));
}

/* ---------- conexão em tempo real ---------- */
function connect() {
  A.sock = liveSocket(() => `/ws/admin?token=${encodeURIComponent(A.token)}`, {
    onstatus: (s) => { A.conn = s; renderBar(); },
    onmessage: (m) => {
      if (m.t === "init") { A.polls = new Map(m.polls.map((p) => [p.id, p])); A.loaded = true; if (!A.sel && m.polls[0]) A.sel = m.polls[0].id; if (A.sel && !A.polls.has(A.sel)) A.sel = m.polls[0]?.id || null; if (editing(A.sel)) { renderSide(); renderBar(); } else renderAll(); }
      else if (m.t === "poll") {
        A.polls.set(m.poll.id, m.poll);
        if (editing(m.poll.id)) { renderSide(); renderBar(); } else renderAll();
      }
      else if (m.t === "live") { const p = A.polls.get(m.poll); if (!p) return; p.participants = m.participants; p.results = m.results; renderSide(); renderBar(); if (A.sel === m.poll) { renderHead(); if (["participantes", "resultados"].includes(A.tab) && A.view === "poll") renderTab(); } }
      else if (m.t === "deleted") { A.polls.delete(m.poll); if (A.sel === m.poll) { A.sel = A.polls.keys().next().value || null; A.view = "poll"; } renderAll(); }
    },
  });
}
// true quando há um formulário aberto que não deve ser recriado por eventos ao vivo
const editing = (id) => A.view === "new" || (A.view === "poll" && A.tab === "editar" && A.sel === id);
function boot() { A.view = "poll"; layout(); connect(); }

/* ---------- layout ---------- */
function layout() {
  root.replaceChildren(h("div", { class: "adm" },
    h("div", { class: "bar", id: "bar" }),
    h("div", { class: "layout" }, h("aside", { class: "card side", id: "side" }), h("section", { class: "card main", id: "main" }))));
  renderAll();
}
function renderAll() { renderBar(); renderSide(); renderMain(); }
function renderBar() {
  const bar = $("#bar"); if (!bar) return;
  const online = [...A.polls.values()].reduce((n, p) => n + p.participants.filter((x) => x.online && x.status === "active").length, 0);
  bar.replaceChildren(h("h1", {}, "Votações · Administração"),
    h("div", { class: "row", style: "display:flex;gap:14px;align-items:center" },
      h("span", { class: "conn " + A.conn }, h("i"), A.conn === "on" ? `ao vivo · ${online} online` : "reconectando…"),
      h("button", { class: "btn ghost sm", type: "button", onclick: logout }, "Sair")));
}
function renderSide() {
  const side = $("#side"); if (!side) return;
  const ul = h("ul", { class: "plist" });
  for (const p of A.polls.values()) {
    const on = p.participants.filter((x) => x.online && x.status === "active").length;
    ul.append(h("li", {}, h("button", { type: "button", class: p.id === A.sel && A.view !== "new" ? "on" : "", onclick: () => { A.sel = p.id; A.view = "poll"; A.tab = "participantes"; renderAll(); } },
      h("span", { class: "t" }, p.title),
      h("span", { class: "m" }, h("span", { class: "dot " + (on ? "on" : "") }), `${on} online · ${p.participants.filter((x) => x.status === "active").length} inscritos`, p.status === "closed" ? h("span", { class: "chip closed" }, "encerrada") : null))));
  }
  side.replaceChildren(h("button", { class: "btn", type: "button", style: "width:100%", onclick: () => { A.view = "new"; renderAll(); } }, "+ Nova votação"),
    h("h3", { style: "margin-top:16px" }, "Votações"), A.loaded ? (A.polls.size ? ul : h("p", { class: "small" }, "Nenhuma votação criada ainda.")) : h("p", { class: "small" }, "Carregando…"));
}
function renderMain() {
  const main = $("#main"); if (!main) return;
  if (A.view === "new") { main.replaceChildren(formView(null)); return; }
  const p = A.polls.get(A.sel);
  if (!p) { main.replaceChildren(h("div", { class: "empty" }, A.loaded ? "Crie sua primeira votação em “+ Nova votação”." : "Carregando…")); return; }
  main.replaceChildren(h("div", { id: "head" }), h("div", { class: "tabs", id: "tabs" }), h("div", { id: "tab" }));
  A.view = A.view === "form" ? "form" : "poll";
  renderHead(); renderTabs(); renderTab();
}
function renderHead() {
  const head = $("#head"); const p = A.polls.get(A.sel); if (!head || !p) return;
  const act = p.participants.filter((x) => x.status === "active");
  head.replaceChildren(h("div", { class: "head2" }, h("h2", {}, p.title), h("span", { class: "chip " + (p.status === "closed" ? "closed" : "") }, p.status === "closed" ? "Encerrada" : "Aberta")),
    h("div", { class: "stats small" },
      h("span", {}, h("b", {}, act.filter((x) => x.online).length), " online agora"), "·",
      h("span", {}, h("b", {}, act.length), " inscritos"), "·",
      h("span", {}, h("b", {}, p.results.respondents), " já votaram")));
}
function renderTabs() {
  const t = $("#tabs"); if (!t) return;
  const tabs = [["participantes", "Participantes"], ["resultados", "Resultados"], ["qr", "QR Code"], ["editar", "Editar"]];
  t.replaceChildren(...tabs.map(([k, l]) => h("button", { type: "button", class: A.tab === k && A.view === "poll" ? "on" : "", onclick: () => { A.tab = k; A.view = "poll"; renderTabs(); renderTab(); } }, l)));
}
function renderTab() {
  const el = $("#tab"); const p = A.polls.get(A.sel); if (!el || !p) return;
  if (A.tab === "participantes") el.replaceChildren(tabParticipants(p));
  else if (A.tab === "resultados") el.replaceChildren(tabResults(p));
  else if (A.tab === "qr") el.replaceChildren(tabQR(p));
  else { A.formMode = "edit"; el.replaceChildren(formView(p)); }
}

/* ---------- participantes ---------- */
function tabParticipants(p) {
  const active = p.participants.filter((x) => x.status === "active").sort((a, b) => b.online - a.online || a.name.localeCompare(b.name, "pt-BR"));
  const kicked = p.participants.filter((x) => x.status === "kicked");
  const w = h("div", {});
  if (!active.length) w.append(h("div", { class: "empty" }, "Ninguém entrou ainda. Mostre o QR Code (aba “QR Code”) para os participantes."));
  else {
    const tb = h("tbody", {});
    for (const x of active) {
      tb.append(h("tr", {},
        h("td", {}, h("span", { class: "dot " + (x.online ? "on" : "") }), " ", x.online ? "Online" : "Offline"),
        h("td", {}, h("b", {}, x.name)),
        h("td", {}, hhmm(x.joined_at)),
        h("td", { style: "min-width:140px" }, h("div", { class: "pbar" }, h("i", { style: `width:${Math.round((x.answered / x.total) * 100)}%` })), h("span", { class: "small" }, `${x.answered}/${x.total} respostas`)),
        h("td", { class: "c" }, h("button", { class: "btn danger sm", type: "button", onclick: () => kick(p, x) }, "Expulsar"))));
    }
    w.append(h("table", { class: "t" }, h("thead", {}, h("tr", {}, ["Situação", "Nome", "Entrou às", "Progresso", ""].map((c) => h("th", {}, c)))), tb));
  }
  if (kicked.length) {
    w.append(h("h3", { style: "margin:24px 0 8px;color:var(--err)" }, `Expulsos (${kicked.length})`),
      h("table", { class: "t" }, h("tbody", {}, kicked.map((x) => h("tr", {}, h("td", {}, h("b", {}, x.name)), h("td", { class: "small" }, "Não pode voltar com este nome"),
        h("td", { class: "c" }, h("button", { class: "btn ghost sm", type: "button", onclick: () => api(`/api/polls/${p.id}/participants/${x.id}/unkick`, { method: "POST" }) }, "Readmitir")))))));
  }
  return w;
}
function kick(p, x) {
  if (!confirm(`Expulsar “${x.name}” desta votação?\n\nOs votos dessa pessoa deixam de contar e o nome fica bloqueado.`)) return;
  api(`/api/polls/${p.id}/participants/${x.id}/kick`, { method: "POST" }).catch((e) => alert(e.message));
}

/* ---------- resultados ---------- */
function tabResults(p) {
  const nS = p.sections.length;
  const head = h("tr", {}, h("th", {}, "Pergunta"), p.sections.map((s, i) => h("th", { class: "c", title: s.title }, `Seção ${i + 1}`)));
  const body = h("tbody", {}, p.questions.map((q, j) => h("tr", {}, h("td", {}, q), p.sections.map((_, i) => { const c = p.results.cells[`${i}_${j}`]; return h("td", { class: "c" }, c ? fmt(c.avg) : "–"); }))));
  const foot = h("tr", {}, h("td", {}, h("b", {}, "Média da seção")), p.sections.map((_, i) => {
    let s = 0, n = 0; p.questions.forEach((_, j) => { const c = p.results.cells[`${i}_${j}`]; if (c) { s += c.avg * c.n; n += c.n; } });
    return h("td", { class: "c" }, h("b", {}, fmt(n ? s / n : 0)));
  }));
  return h("div", {},
    h("div", { class: "head2" }, h("p", { class: "small", style: "margin:0" }, `${p.results.respondents} participante(s) com notas. Atualiza em tempo real; votos de expulsos não entram.`),
      h("button", { class: "btn ghost sm", type: "button", onclick: () => exportCsv(p) }, "Baixar CSV")),
    h("div", { style: "overflow-x:auto" }, h("table", { class: "t" }, h("thead", {}, head), body, h("tfoot", {}, foot))),
    p.sections.some((s) => s.title) ? h("p", { class: "small", style: "margin-top:12px" }, p.sections.map((s, i) => `Seção ${i + 1}: ${s.title || "—"}`).join("  ·  ")) : null);
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
  ctx.fillStyle = "#285a7a"; ctx.textAlign = "center"; ctx.font = "700 40px 'Segoe UI',Arial,sans-serif";
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
  return h("div", { class: "qrwrap" }, canvas, h("div", { class: "qrside" },
    h("h3", { style: "margin:0 0 4px;color:var(--title)" }, "Link da votação"),
    h("div", { class: "linkbox" }, inp, copy),
    h("div", { class: "actions", style: "margin-top:0" },
      h("button", { class: "btn", type: "button", onclick: () => canvas.toBlob((b) => { const a = h("a", { href: URL.createObjectURL(b), download: `qr-${p.id}.png` }); document.body.append(a); a.click(); a.remove(); }) }, "Baixar PNG"),
      h("button", { class: "btn ghost", type: "button", onclick: () => window.print() }, "Imprimir")),
    h("p", { class: "small", style: "margin-top:16px" }, "Quem escanear precisa informar o nome antes de iniciar a votação. Você acompanha quem entrou na aba “Participantes” e pode expulsar quem não for convidado."),
    p.status === "closed" ? h("div", { class: "notice" }, "Esta votação está encerrada: novos participantes não conseguem entrar.") : null));
}

/* ---------- formulário (criar / editar) ---------- */
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

function formView(p) {
  const edit = !!p; A.formMode = edit ? "edit" : "new";
  const sel = (items, val) => { const s = h("select", {}); items.forEach((i) => { const o = h("option", { value: i }, i); if (i === val) o.selected = true; s.append(o); }); return s; };
  const rodada = sel(RODADAS, p?.rodada || RODADAS[0]);
  const turno = sel(TURNOS, p?.turno || TURNOS[0]);
  const cat = h("input", { type: "text", list: "cats", maxlength: "40", value: p?.categoria || CATS[0], placeholder: "Ex.: Segurança" });
  const dl = h("datalist", { id: "cats" }, CATS.map((c) => h("option", { value: c })));
  const title = h("input", { type: "text", maxlength: "120", value: edit ? p.title : "", placeholder: "Opcional — padrão: rodada + categoria + turno" });
  const qs = h("textarea", { rows: "7" }); qs.value = (p?.questions || DEF_Q).join("\n");

  const drafts = (p?.sections || Array.from({ length: 4 }, () => ({ title: "", img: null }))).map((s) => ({ title: s.title, img: s.img, file: null, removed: false }));
  const list = h("div", {});
  const drawSecs = () => {
    list.replaceChildren(...drafts.map((d, i) => {
      const t = h("input", { type: "text", maxlength: "120", placeholder: `Título da seção ${i + 1} (ex.: Usinagem de Eixos A)`, value: d.title }); t.addEventListener("input", () => (d.title = t.value));
      const pv = h("div", {}); const showPv = () => { pv.replaceChildren(); const src = d.file ? URL.createObjectURL(d.file) : d.removed ? null : d.img; if (src) pv.append(h("img", { src, alt: "" })); };
      const f = h("input", { type: "file", accept: "image/*" });
      f.addEventListener("change", async () => { if (!f.files[0]) return; try { d.file = await resizeImage(f.files[0]); d.removed = false; showPv(); } catch (e) { alert(e.message); } });
      showPv();
      return h("div", { class: "secrow" }, h("b", {}, `Seção ${i + 1}`), t, h("div", { class: "r" }, f, h("button", { class: "btn ghost sm", type: "button", onclick: () => { d.file = null; d.removed = true; f.value = ""; showPv(); } }, "Remover imagem")), pv);
    }));
  };
  drawSecs();
  const err = h("div", { class: "err-text" });
  const submit = h("button", { class: "btn", type: "button" }, edit ? "Salvar alterações" : "Criar votação");
  submit.addEventListener("click", async () => {
    err.textContent = ""; submit.disabled = true; submit.textContent = "Salvando…";
    try {
      const body = JSON.stringify({ rodada: rodada.value, categoria: cat.value, turno: turno.value, title: title.value, sections: drafts.map((d) => ({ title: d.title })), questions: qs.value.split("\n") });
      const poll = edit ? (await api(`/api/polls/${p.id}`, { method: "PUT", body }), p) : await api("/api/polls", { method: "POST", body });
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        if (d.file) await api(`/api/polls/${poll.id}/image/${i}`, { method: "PUT", body: d.file, headers: { "content-type": "image/jpeg" } });
        else if (d.removed && d.img) await api(`/api/polls/${poll.id}/image/${i}`, { method: "DELETE" });
      }
      A.sel = poll.id; A.view = "poll"; A.tab = edit ? "editar" : "qr"; renderAll();
    } catch (e) { err.textContent = e.message; submit.disabled = false; submit.textContent = edit ? "Salvar alterações" : "Criar votação"; }
  });
  const extra = [];
  if (edit) {
    extra.push(h("button", { class: "btn ghost", type: "button", onclick: () => api(`/api/polls/${p.id}`, { method: "PUT", body: JSON.stringify({ status: p.status === "open" ? "closed" : "open" }) }).catch((e) => alert(e.message)) }, p.status === "open" ? "Encerrar votação" : "Reabrir votação"));
    extra.push(h("button", { class: "btn danger", type: "button", onclick: () => { if (confirm(`Excluir “${p.title}”?\n\nTodos os votos e participantes serão apagados. Esta ação não pode ser desfeita.`)) api(`/api/polls/${p.id}`, { method: "DELETE" }).catch((e) => alert(e.message)); } }, "Excluir"));
  }
  return h("div", {}, edit ? null : h("h2", { style: "margin-bottom:14px" }, "Nova votação"), dl,
    h("div", { class: "formgrid" }, h("div", {}, h("label", { class: "lbl" }, "Rodada"), rodada), h("div", {}, h("label", { class: "lbl" }, "Categoria"), cat), h("div", {}, h("label", { class: "lbl" }, "Turno"), turno)),
    h("div", { style: "margin-bottom:14px" }, h("label", { class: "lbl" }, "Título"), title),
    h("label", { class: "lbl" }, `Seções (${drafts.length}) — cada uma com sua imagem`), list,
    h("div", { class: "r", style: "display:flex;gap:10px;margin:6px 0 16px" },
      h("button", { class: "btn ghost sm", type: "button", onclick: () => { if (drafts.length < 12) { drafts.push({ title: "", img: null, file: null, removed: false }); drawSecs(); } } }, "+ Adicionar seção"),
      h("button", { class: "btn ghost sm", type: "button", onclick: () => { if (drafts.length > 1 && confirm("Remover a última seção? Os votos dela serão apagados ao salvar.")) { drafts.pop(); drawSecs(); } } }, "− Remover última")),
    h("label", { class: "lbl" }, "Perguntas (uma por linha, notas de 1 a 5)"), qs,
    err, h("div", { class: "actions" }, submit, ...extra));
}

/* ---------- início ---------- */
if (A.token) boot(); else showLogin();
