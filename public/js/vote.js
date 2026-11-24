/* Página do votante: /v/:id  — exige nome, vota em tempo real, pode ser expulso pelo admin */
const pollId = location.pathname.split("/")[2];
const KEY = "olp:" + pollId;
const ESCALA = ["Muito fraco", "Fraco", "Regular", "Bom", "Excelente"];
const S = { poll: null, token: null, name: null, votes: {}, step: 0, conn: "off", dead: null, sock: null, nameErr: "", busy: false };
const root = $("#root");

const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ token: S.token, name: S.name })); } catch {} };
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
const closed = () => S.poll?.status === "closed";
const nSec = () => S.poll.sections.length;
const nQ = () => S.poll.questions.length;
const getV = (i, j) => S.votes[`${i}_${j}`] || 0;

/* ---------- boot ---------- */
(async function boot() {
  document.title = "Votação";
  let r;
  try { r = await fetch(`/api/p/${pollId}`); } catch { return full("📡", "Sem conexão", "Não foi possível carregar a votação. Verifique sua internet e recarregue."); }
  if (r.status === 404) return full("🔎", "Votação não encontrada", "Este link ou QR code não está mais ativo.");
  S.poll = await r.json();
  document.title = S.poll.title;
  const st = load();
  if (st?.token) {
    const j = await join({ token: st.token });
    if (j.ok) { S.token = j.token; S.name = j.name; return start(); }
    if (j.error === "kicked") return kicked();
  }
  S.step = "name"; render();
})();

async function join(body) {
  try {
    const r = await fetch(`/api/p/${pollId}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...b } : { ok: false, error: b.error || "erro" };
  } catch { return { ok: false, error: "Sem conexão. Tente novamente." }; }
}

function start() {
  S.step = 0; render();
  S.sock = liveSocket(() => `/ws/p/${pollId}?token=${encodeURIComponent(S.token)}`, {
    onstatus: (s) => { S.conn = s; renderTop(); },
    onmessage: (m) => {
      if (m.t === "hello") {
        S.poll = m.poll;
        const local = S.votes; S.votes = { ...m.votes, ...local };
        for (const [k, v] of Object.entries(local)) if (m.votes[k] !== v) { const [sec, q] = k.split("_").map(Number); S.sock.send({ t: "vote", sec, q, value: v }); }
        if (S.step >= nSec()) S.step = nSec() - 1;
        render(true);
      } else if (m.t === "poll") {
        S.poll = m.poll; document.title = S.poll.title;
        if (typeof S.step === "number" && S.step >= nSec()) S.step = nSec() - 1;
        render(true);
      } else if (m.t === "kicked") { S.sock.close(); kicked(); }
      else if (m.t === "denied") { S.sock.close(); full("🚫", m.reason === "deleted" ? "Votação encerrada" : "Acesso negado", m.reason === "deleted" ? "Esta votação foi removida pelo organizador." : "Entre novamente pelo QR code."); }
      else if (m.t === "closed") { S.poll.status = "closed"; render(true); }
    },
  });
}

/* ---------- telas finais ---------- */
function full(ico, title, text) {
  S.dead = true;
  root.replaceChildren(h("div", { class: "card full" }, h("div", { class: "ico" }, ico), h("h1", {}, title), h("p", {}, text)));
}
function kicked() { full("⛔", "Você foi removido desta votação", "O organizador removeu seu acesso. Se acredita que foi um engano, fale com ele."); }

/* ---------- render ---------- */
function render(keep) {
  if (S.dead) return;
  const ready = S.step !== "name";
  const p = S.poll;
  const body = h("div", { class: "body" }, h("h1", {}, p.rodada, h("br"), p.categoria, p.turno ? h("br") : null, p.turno),
    h("p", { class: "sub" }, ready ? (S.step === "done" ? "Obrigado pela participação!" : "Você está convidado!") : "Identifique-se para participar"));
  if (typeof S.step === "number") {
    body.append(h("div", { class: "progress" }, h("div", { class: "bar" }, h("i", { style: `width:${Math.round((S.step / nSec()) * 100)}%` })), h("small", {}, `Seção ${S.step + 1} de ${nSec()}`)));
  }
  const left = h("aside", { class: "card left" },
    bannerEl(p.banner), body);
  const view = h("div", { class: "inner", id: "view" });
  view.append(S.step === "name" ? viewName() : S.step === "done" ? viewDone() : viewSection(S.step));
  root.replaceChildren(h("div", { class: "app" }, left,
    h("main", { class: "card right" }, h("div", { class: "top" }, h("span", { id: "topL" }), h("span", { id: "topR", class: "conn" })), view)));
  renderTop();
  if (!keep) window.scrollTo({ top: 0, behavior: "smooth" });
}
function renderTop() {
  const l = $("#topL"), r = $("#topR"); if (!l) return;
  l.textContent = typeof S.step === "number" ? `Seção ${S.step + 1}` : S.step === "done" ? "Concluído" : "Identificação";
  r.className = "conn " + (S.step === "name" ? "" : S.conn);
  r.replaceChildren(h("i"), S.step === "name" ? "" : (S.name ? S.name + " · " : "") + (S.conn === "on" ? "ao vivo" : "reconectando…"));
}

function viewName() {
  const input = h("input", { type: "text", id: "nm", placeholder: "Seu nome completo", maxlength: "60", autocomplete: "name", autofocus: true });
  const err = h("div", { class: "err-text" }, S.nameErr);
  const go = async () => {
    if (S.busy) return;
    const name = input.value.trim();
    if (name.length < 2) { err.textContent = "Digite seu nome para continuar."; input.focus(); return; }
    S.busy = true; btn.disabled = true; err.textContent = "";
    const j = await join({ name });
    S.busy = false;
    if (j.ok) { S.token = j.token; S.name = j.name; save(); return start(); }
    if (j.error === "kicked") return kicked();
    if (j.error === "closed") return full("🔒", "Votação encerrada", "Esta votação não está mais aceitando participantes.");
    btn.disabled = false; err.textContent = j.error;
  };
  const btn = h("button", { class: "btn", type: "button", onclick: go }, "Continuar");
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  return h("div", { class: "gate" }, h("h2", {}, "Qual é o seu nome?"),
    h("p", {}, "Informe seu nome antes de iniciar. Ele será visto pelo organizador da votação."),
    h("div", { class: "row" }, input, btn), err);
}

function viewSection(i) {
  const sec = S.poll.sections[i];
  const w = h("div", { class: closed() ? "locked" : "" });
  if (closed()) w.append(h("div", { class: "banner-closed" }, "Esta votação foi encerrada. Suas notas anteriores estão registradas, mas não é possível alterá-las."));
  w.append(h("p", { class: "scale-note" }, "1 = muito fraco · 5 = excelente. Todas as perguntas são obrigatórias."));
  const img = sec.img
    ? h("button", { class: "img", type: "button", "aria-label": "Ampliar imagem", onclick: () => { $("#lb img").src = sec.img; $("#lb").classList.add("open"); } },
        h("img", { src: sec.img, alt: sec.title || `Seção ${i + 1}` }), h("span", { class: "zoom" }, "🔍 ampliar"))
    : h("div", { class: "img ph" }, sec.pdf ? "Relatório em PDF — toque em “Abrir PDF completo”" : "Sem imagem nesta seção");
  const pdfBtn = sec.pdf ? h("a", { class: "btn ghost sm pdfbtn", href: sec.pdf, target: "_blank", rel: "noopener" }, "📄 Abrir PDF completo") : null;
  w.append(h("div", { class: "figure" }, h("div", { class: "cap" }, h("div", {}, sec.title || `Seção ${i + 1}`), pdfBtn), img));
  S.poll.questions.forEach((q, j) => w.append(question(i, j, q)));
  const last = i === nSec() - 1;
  w.append(h("div", { class: "nav" },
    i > 0 ? h("button", { class: "btn ghost", type: "button", onclick: () => { S.step = i - 1; render(); } }, "Voltar") : h("span"),
    h("div", { class: "dots" }, Array.from({ length: nSec() }, (_, k) => h("i", { class: k === i ? "cur" : k < i ? "done" : "" }))),
    h("button", { class: "btn", type: "button", onclick: () => {
      const miss = []; for (let j = 0; j < nQ(); j++) if (!getV(i, j)) miss.push(j);
      const qs = document.querySelectorAll(".q"); qs.forEach((el, j) => el.classList.toggle("err", miss.includes(j)));
      if (miss.length) { qs[miss[0]].scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      S.step = last ? "done" : i + 1; render();
    } }, last ? "Enviar" : "Próximo")));
  return w;
}

function question(i, j, text) {
  const el = h("div", { class: "q" }), cur = getV(i, j), btns = [];
  const stars = h("div", { class: "stars", role: "radiogroup", "aria-label": text });
  for (let n = 1; n <= 5; n++) {
    const b = h("button", { type: "button", role: "radio", "aria-checked": String(cur === n), "aria-label": `${n} de 5 – ${ESCALA[n - 1]}`, title: ESCALA[n - 1], class: n <= cur ? "on" : "" });
    b.innerHTML = STAR; b.append(h("span", { class: "n" }, String(n)));
    b.addEventListener("mouseenter", () => !closed() && btns.forEach((x, k) => x.classList.toggle("hov", k < n && k >= getV(i, j))));
    b.addEventListener("mouseleave", () => btns.forEach((x) => x.classList.remove("hov")));
    b.addEventListener("click", () => {
      if (closed()) return;
      S.votes[`${i}_${j}`] = n;
      btns.forEach((x, k) => { x.classList.toggle("on", k < n); x.setAttribute("aria-checked", String(k + 1 === n)); x.classList.remove("hov"); });
      el.classList.remove("err");
      S.sock?.send({ t: "vote", sec: i, q: j, value: n });   // se offline, é reenviado ao reconectar
    });
    btns.push(b); stars.append(b);
  }
  el.append(h("div", { class: "head" }, h("div", { class: "num" }, String(j + 1)), h("div", { class: "txt" }, text + " ", h("b", {}, "*"))),
    stars, h("div", { class: "msg" }, "Selecione uma nota para continuar."));
  return el;
}

function viewDone() {
  return h("div", { class: "done" }, h("div", { class: "check" }, "✓"), h("h2", {}, "Avaliação enviada!"),
    h("p", {}, `${S.poll.rodada} · ${S.poll.categoria}${S.poll.turno ? " · " + S.poll.turno : ""}`),
    h("p", {}, `Obrigado, ${S.name}. Suas notas foram registradas.`),
    S.conn !== "on" ? h("div", { class: "notice" }, "Você está sem conexão no momento. As notas serão enviadas assim que a internet voltar — mantenha esta página aberta.") : null,
    !closed() ? h("div", { style: "margin-top:22px" }, h("button", { class: "btn ghost", type: "button", onclick: () => { S.step = 0; render(); } }, "Revisar respostas")) : null);
}

$("#lb").addEventListener("click", () => $("#lb").classList.remove("open"));
document.addEventListener("keydown", (e) => e.key === "Escape" && $("#lb").classList.remove("open"));
