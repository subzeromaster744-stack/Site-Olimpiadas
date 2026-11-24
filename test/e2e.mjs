// Teste de ponta a ponta contra `wrangler dev` (http://localhost:8787)
const BASE = process.env.BASE || "http://localhost:8787";
const PASS = process.env.ADMIN_PASSWORD || "admin123";
const WS = BASE.replace(/^http/, "ws");
let fails = 0;
const ok = (c, msg) => { console.log((c ? "OK   " : "FAIL ") + msg); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = async (path, opts = {}) => { const r = await fetch(BASE + path, opts); let b = null; try { b = await r.clone().json(); } catch {} return { r, b }; };

function sock(url) {
  const ws = new WebSocket(url); const msgs = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(e.data));
  const opened = new Promise((res) => (ws.onopen = res));
  let closed = null; ws.onclose = (e) => (closed = e.code);
  return { ws, msgs, opened, get closed() { return closed; } };
}

// login
let x = await J("/api/admin/login", { method: "POST", body: JSON.stringify({ password: "errada" }) });
ok(x.r.status === 401, "login com senha errada = 401");
x = await J("/api/admin/login", { method: "POST", body: JSON.stringify({ password: PASS }) });
ok(x.r.status === 200 && x.b.token, "login ok");
const T = x.b.token, AH = { authorization: "Bearer " + T, "content-type": "application/json" };

x = await J("/api/polls");
ok(x.r.status === 401, "listar votações sem token = 401");

// admin ws
const adm = sock(`${WS}/ws/admin?token=${T}`); await adm.opened; await sleep(200);
ok(adm.msgs[0]?.t === "init", "admin recebe init");

// criar votação
x = await J("/api/polls", { method: "POST", headers: AH, body: JSON.stringify({ rodada: "2ª Rodada", categoria: "Segurança", turno: "2º Turno" }) });
const poll = x.b; ok(x.r.status === 201 && poll.id && poll.sections.length === 4 && poll.questions.length === 6, "criar votação (4 seções, 6 perguntas)");
ok(poll.title === "2ª Rodada Segurança 2º Turno", "título automático");
await sleep(200); ok(adm.msgs.some((m) => m.t === "poll" && m.poll.id === poll.id), "admin recebe poll em tempo real");

// imagem
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
x = await J(`/api/polls/${poll.id}/image/0`, { method: "PUT", headers: { authorization: "Bearer " + T, "content-type": "image/png" }, body: png });
ok(x.r.status === 200, "upload de imagem");
x = await J(`/api/p/${poll.id}`); ok(x.b.sections[0].img?.startsWith(`/img/${poll.id}/0?v=`), "poll público expõe img");
const img = await fetch(BASE + x.b.sections[0].img); ok(img.status === 200 && img.headers.get("content-type") === "image/png", "servir imagem");

// entrar sem nome
x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ name: " " }) });
ok(x.r.status === 400, "entrar sem nome é recusado");
x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ name: "Maria Silva" }) });
const maria = x.b; ok(x.r.status === 200 && maria.token, "Maria entra");
x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ name: "Intruso" }) });
const intruso = x.b;

// ws votantes
const sm = sock(`${WS}/ws/p/${poll.id}?token=${maria.token}`); await sm.opened;
const si = sock(`${WS}/ws/p/${poll.id}?token=${intruso.token}`); await si.opened; await sleep(300);
ok(sm.msgs[0]?.t === "hello" && sm.msgs[0].name === "Maria Silva", "Maria recebe hello");
let live = adm.msgs.filter((m) => m.t === "live" && m.poll === poll.id).at(-1);
ok(live.participants.filter((p) => p.online).length === 2, "admin vê 2 online");

// votos
sm.ws.send(JSON.stringify({ t: "vote", sec: 0, q: 0, value: 5 }));
sm.ws.send(JSON.stringify({ t: "vote", sec: 0, q: 1, value: 3 }));
si.ws.send(JSON.stringify({ t: "vote", sec: 0, q: 0, value: 1 }));
sm.ws.send(JSON.stringify({ t: "vote", sec: 9, q: 0, value: 4 }));   // inválido
sm.ws.send(JSON.stringify({ t: "vote", sec: 0, q: 2, value: 9 }));   // inválido
await sleep(400);
live = adm.msgs.filter((m) => m.t === "live" && m.poll === poll.id).at(-1);
ok(live.results.cells["0_0"].n === 2 && live.results.cells["0_0"].avg === 3, "média 0_0 = 3 com 2 votos");
ok(live.participants.find((p) => p.name === "Maria Silva").answered === 2, "progresso da Maria = 2 (inválidos ignorados)");

// expulsar intruso
x = await J(`/api/polls/${poll.id}/participants/${intruso.token}/kick`, { method: "POST", headers: AH });
ok(x.r.status === 200, "kick ok"); await sleep(300);
ok(si.msgs.some((m) => m.t === "kicked") && si.closed === 4403, "intruso recebe kicked e é desconectado");
live = adm.msgs.filter((m) => m.t === "live" && m.poll === poll.id).at(-1);
ok(live.results.cells["0_0"].n === 1 && live.results.cells["0_0"].avg === 5, "voto do expulso sai do resultado");
x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ token: intruso.token }) });
ok(x.r.status === 403 && x.b.error === "kicked", "token do expulso é recusado");
x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ name: "intruso" }) });
ok(x.r.status === 403, "mesmo nome (sem diferenciar maiúscula) é bloqueado");
const si2 = sock(`${WS}/ws/p/${poll.id}?token=${intruso.token}`); await si2.opened; await sleep(300);
ok(si2.msgs[0]?.t === "kicked", "reconectar com token expulso = kicked");

// readmitir
x = await J(`/api/polls/${poll.id}/participants/${intruso.token}/unkick`, { method: "POST", headers: AH });
x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ token: intruso.token }) });
ok(x.r.status === 200, "readmitido pode entrar");

// reconectar Maria: votos restaurados
sm.ws.close(); await sleep(300);
live = adm.msgs.filter((m) => m.t === "live" && m.poll === poll.id).at(-1);
ok(live.participants.find((p) => p.name === "Maria Silva").online === false, "admin vê Maria offline ao fechar");
const sm2 = sock(`${WS}/ws/p/${poll.id}?token=${maria.token}`); await sm2.opened; await sleep(300);
ok(sm2.msgs[0].votes["0_0"] === 5 && sm2.msgs[0].votes["0_1"] === 3, "votos restaurados ao reconectar");

// anular / restaurar respostas
{
  const lastLive = () => adm.msgs.filter((m) => m.t === "live" && m.poll === poll.id).at(-1);
  const act = (pid, a) => J(`/api/polls/${poll.id}/participants/${pid}/${a}`, { method: "POST", headers: AH });
  ok(lastLive().results.cells["0_0"]?.n === 2, "antes de anular: votos da Maria e do readmitido contam (n=2)");
  x = await act(maria.token, "annul"); await sleep(300);
  ok(x.r.status === 200 && lastLive().participants.find((p) => p.id === maria.token).annulled === 1, "anular marca a participante");
  ok(lastLive().results.cells["0_0"]?.n === 1 && lastLive().results.cells["0_0"].avg === 1 && lastLive().results.respondents === 1, "respostas anuladas saem dos resultados (sobra só o outro voto)");
  sm2.ws.send(JSON.stringify({ t: "vote", sec: 0, q: 4, value: 5 })); await sleep(300);
  ok(!lastLive().results.cells["0_4"], "novos votos de quem está anulado também não contam");
  ok(lastLive().participants.find((p) => p.id === maria.token).answered === 3, "as notas continuam guardadas (3)");
  x = await act(maria.token, "restore"); await sleep(300);
  ok(lastLive().results.cells["0_0"]?.n === 2 && lastLive().results.cells["0_4"]?.n === 1, "restaurar volta a contar tudo");
}

// apagar expulsos (um e todos) — migra de volta o nome para "livre"
{
  const lastLive = () => adm.msgs.filter((m) => m.t === "live" && m.poll === poll.id).at(-1);
  const kickOf = (pid) => J(`/api/polls/${poll.id}/participants/${pid}/kick`, { method: "POST", headers: AH });
  await kickOf(intruso.token); await sleep(200);
  const alvo = sock(`${WS}/ws/p/${poll.id}?token=${intruso.token}`); await alvo.opened; await sleep(200);
  x = await J(`/api/polls/${poll.id}/participants/${intruso.token}`, { method: "DELETE", headers: AH }); await sleep(300);
  ok(x.r.status === 200 && !lastLive().participants.some((p) => p.id === intruso.token), "apagar tira o nome da lista");
  x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ token: intruso.token }) });
  ok(x.r.status === 400, "token apagado deixa de existir (pede o nome de novo)");
  x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ name: "Intruso" }) });
  ok(x.r.status === 200, "nome apagado da lista não está mais bloqueado");
  const novo = x.b;
  const outro = (await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ name: "Outro Intruso" }) })).b;
  await kickOf(novo.token); await kickOf(outro.token); await sleep(200);
  ok(lastLive().participants.filter((p) => p.status === "kicked").length === 2, "dois expulsos na lista");
  x = await J(`/api/polls/${poll.id}/kicked`, { method: "DELETE", headers: AH }); await sleep(300);
  ok(x.b.deleted === 2 && !lastLive().participants.some((p) => p.status === "kicked"), "apagar todos os expulsos");
  x = await J(`/api/polls/${poll.id}/participants/${maria.token}`, { method: "DELETE", headers: { authorization: "Bearer " } });
  ok(x.r.status === 401, "apagar sem login = 401");
}

// PDF (3,2 MB => 3 pedaços no banco)
{
  const { createHash } = await import("node:crypto");
  const pdf = new Uint8Array(3_200_000); pdf.set(new TextEncoder().encode("%PDF-1.4\n"));
  for (let i = 9; i < pdf.length; i++) pdf[i] = (i * 31) & 0xff;
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const PH = { authorization: "Bearer " + T, "content-type": "application/pdf", "x-filename": encodeURIComponent("Relatório Ação.pdf") };
  x = await J(`/api/polls/${poll.id}/pdf/1`, { method: "PUT", headers: PH, body: pdf });
  ok(x.r.status === 200, "upload de PDF de 3,2 MB");
  x = await J(`/api/p/${poll.id}`);
  ok(x.b.sections[1].pdf?.startsWith(`/pdf/${poll.id}/1?v=`) && x.b.sections[1].pdfName === "Relatório Ação.pdf" && x.b.sections[1].pdfSize === pdf.length, "poll público expõe pdf, nome e tamanho");
  ok(x.b.sections[0].pdf === null, "seção sem PDF fica nula");
  const got = await fetch(BASE + x.b.sections[1].pdf);
  const bytes = new Uint8Array(await got.arrayBuffer());
  ok(got.status === 200 && got.headers.get("content-type") === "application/pdf" && bytes.length === pdf.length && sha(bytes) === sha(pdf), "PDF baixado é idêntico ao enviado (sha256)");
  ok((got.headers.get("content-disposition") || "").includes("inline"), "PDF abre inline no navegador");
  x = await J(`/api/polls/${poll.id}/pdf/1`, { method: "PUT", headers: { ...PH }, body: new TextEncoder().encode("isto nao e pdf") });
  ok(x.r.status === 415, "arquivo que não é PDF é recusado");
  x = await J(`/api/polls/${poll.id}/pdf/1`, { method: "PUT", headers: { authorization: "Bearer " + T, "content-type": "application/pdf" }, body: new Uint8Array(21 * 1024 * 1024) });
  ok(x.r.status === 413, "PDF acima de 20 MB é recusado");
  x = await J(`/api/polls/${poll.id}/pdf/1`, { method: "PUT", headers: { "content-type": "application/pdf" }, body: pdf });
  ok(x.r.status === 401, "upload de PDF sem login = 401");
  const pdf2 = pdf.slice(0, 1000); // substituir por um menor remove os pedaços antigos
  x = await J(`/api/polls/${poll.id}/pdf/1`, { method: "PUT", headers: PH, body: pdf2 });
  const got2 = new Uint8Array(await (await fetch(BASE + (await J(`/api/p/${poll.id}`)).b.sections[1].pdf)).arrayBuffer());
  ok(got2.length === 1000, "substituir PDF troca o conteúdo");
  x = await J(`/api/polls/${poll.id}/pdf/1`, { method: "DELETE", headers: AH });
  x = await J(`/api/p/${poll.id}`);
  ok(x.b.sections[1].pdf === null, "remover PDF");
  await J(`/api/polls/${poll.id}/pdf/3`, { method: "PUT", headers: PH, body: pdf2 });
  await J(`/api/polls/${poll.id}`, { method: "PUT", headers: AH, body: JSON.stringify({ sections: [{ title: "a" }, { title: "b" }] }) });
  x = await J(`/api/p/${poll.id}`);
  ok(x.b.sections.length === 2 && (await fetch(`${BASE}/pdf/${poll.id}/3`)).status === 404, "reduzir seções apaga PDFs das removidas");
}

// encerrar
x = await J(`/api/polls/${poll.id}`, { method: "PUT", headers: AH, body: JSON.stringify({ status: "closed" }) });
sm2.ws.send(JSON.stringify({ t: "vote", sec: 0, q: 3, value: 2 })); await sleep(300);
ok(sm2.msgs.some((m) => m.t === "closed"), "voto após encerrar é recusado");
x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ name: "Novo Aluno" }) });
ok(x.r.status === 403 && x.b.error === "closed", "novas entradas bloqueadas quando encerrada");

// csv
const csv = await fetch(`${BASE}/api/polls/${poll.id}/export.csv`, { headers: { authorization: "Bearer " + T } });
ok(csv.status === 200 && (await csv.text()).includes("Maria Silva"), "exportar CSV");


// ---------- contas de organizador ----------
{
  const post = (path, body, h = {}) => J(path, { method: "POST", body: JSON.stringify(body), headers: h });
  const suf = Math.random().toString(36).slice(2, 7);
  const ua = `ana_${suf}`, ub = `bia_${suf}`;
  let r1 = await post("/api/auth/register", { username: ua, name: "Ana", password: "123" });
  ok(r1.r.status === 400, "senha curta recusada");
  r1 = await post("/api/auth/register", { username: "admin", password: "123456" });
  ok(r1.r.status === 400, "usuário 'admin' reservado");
  r1 = await post("/api/auth/register", { username: "a b", password: "123456" });
  ok(r1.r.status === 400, "usuário inválido recusado");
  const A1 = await post("/api/auth/register", { username: ua, name: "Ana", password: "segredo1" });
  ok(A1.r.status === 201 && A1.b.token?.startsWith("u.") && A1.b.name === "Ana", "criar conta Ana");
  ok(!JSON.stringify(A1.b).includes("segredo1") && !A1.b.hash, "resposta sem senha/hash");
  r1 = await post("/api/auth/register", { username: ua.toUpperCase(), password: "outra123" });
  ok(r1.r.status === 409, "usuário duplicado (maiúsc.) = 409");
  r1 = await post("/api/auth/login", { username: ua, password: "errada1" });
  ok(r1.r.status === 401, "login com senha errada = 401");
  r1 = await post("/api/auth/login", { username: "naoexiste", password: "segredo1" });
  ok(r1.r.status === 401, "login de usuário inexistente = 401");
  const L1 = await post("/api/auth/login", { username: ua.toUpperCase(), password: "segredo1" });
  ok(L1.r.status === 200 && L1.b.id === A1.b.id, "login Ana ok");
  const B1 = await post("/api/auth/register", { username: ub, name: "Bia", password: "segredo2" });
  const TA = { authorization: "Bearer " + A1.b.token }, TB = { authorization: "Bearer " + B1.b.token };

  let x2 = await J("/api/polls", { headers: { authorization: "Bearer u." + A1.b.id + ".00" } });
  ok(x2.r.status === 401, "token de usuário forjado = 401");
  x2 = await J("/api/polls"); ok(x2.r.status === 401, "sem token = 401");

  x2 = await J("/api/polls", { method: "POST", headers: TA, body: JSON.stringify({ title: "Form da Ana" }) });
  ok(x2.r.status === 201, "Ana cria formulário");
  const pa = x2.b;
  const wa = sock(`${WS}/ws/admin?token=${A1.b.token}`), wb = sock(`${WS}/ws/admin?token=${B1.b.token}`);
  await wa.opened; await wb.opened; await sleep(250);
  ok(wa.msgs[0]?.t === "init" && wa.msgs[0].polls.some((p) => p.id === pa.id), "Ana vê o formulário dela ao vivo");
  ok(wb.msgs[0]?.t === "init" && !wb.msgs[0].polls.some((p) => p.id === pa.id), "Bia não vê o da Ana");
  x2 = await J("/api/polls", { headers: TB }); ok(x2.b.length === 0, "lista da Bia vazia");
  x2 = await J("/api/polls", { headers: TA }); ok(x2.b.length === 1 && x2.b[0].id === pa.id, "lista da Ana tem 1");
  x2 = await J("/api/polls", { headers: AH }); ok(x2.b.some((p) => p.id === pa.id), "administrador vê tudo");

  for (const [m, path, body, ct] of [
    ["PUT", `/api/polls/${pa.id}`, JSON.stringify({ title: "hack" })],
    ["DELETE", `/api/polls/${pa.id}`], ["GET", `/api/polls/${pa.id}/export.csv`],
    ["DELETE", `/api/polls/${pa.id}/kicked`],
    ["PUT", `/api/polls/${pa.id}/image/0`, new Uint8Array([1, 2, 3]), "image/png"],
  ]) {
    x2 = await J(path, { method: m, headers: { ...TB, ...(ct ? { "content-type": ct } : {}) }, body });
    ok(x2.r.status === 404, `Bia não consegue ${m} ${path.replace(pa.id, "<ana>")} (404)`);
  }
  x2 = await J(`/api/p/${pa.id}`); ok(x2.b.title === "Form da Ana", "formulário continua intacto e público para votar");

  // votante entra no form da Ana; só Ana é avisada
  x2 = await J(`/api/p/${pa.id}/join`, { method: "POST", body: JSON.stringify({ name: "Carlos" }) });
  await sleep(250);
  ok(wa.msgs.some((m) => m.t === "live" && m.poll === pa.id && m.participants.length === 1), "Ana recebe entrada do votante");
  ok(!wb.msgs.some((m) => m.poll === pa.id || m.poll?.id === pa.id), "Bia não recebe nada do form da Ana");
  const pid = x2.b.token;
  x2 = await J(`/api/polls/${pa.id}/participants/${pid}/kick`, { method: "POST", headers: TB });
  ok(x2.r.status === 404, "Bia não expulsa votante da Ana");
  x2 = await J(`/api/polls/${pa.id}/participants/${pid}/annul`, { method: "POST", headers: TA });
  ok(x2.r.status === 200, "Ana anula votante");

  x2 = await J("/api/polls", { method: "POST", headers: TB, body: JSON.stringify({ title: "Form da Bia" }) });
  const pb = x2.b; await sleep(250);
  ok(wb.msgs.some((m) => m.t === "poll" && m.poll.id === pb.id) && !wa.msgs.some((m) => m.t === "poll" && m.poll.id === pb.id), "form novo da Bia só chega para a Bia");
  x2 = await J("/api/polls", { headers: AH }); ok(x2.b.length >= 2, "administrador vê os dois");
  await J(`/api/polls/${pb.id}`, { method: "DELETE", headers: TB });
  await J(`/api/polls/${pa.id}`, { method: "DELETE", headers: TA }); await sleep(250);
  ok(wa.msgs.some((m) => m.t === "deleted" && m.poll === pa.id) && !wb.msgs.some((m) => m.t === "deleted" && m.poll === pa.id), "exclusão avisa só o dono");
  wa.ws.close(); wb.ws.close();
}

// páginas
for (const [p, s] of [["/", 200], ["/admin", 200], [`/v/${poll.id}`, 200]]) { const r = await fetch(BASE + p); ok(r.status === s, `GET ${p} = ${r.status}`); }

// excluir
x = await J(`/api/polls/${poll.id}`, { method: "DELETE", headers: AH }); await sleep(300);
ok(x.r.status === 200 && sm2.msgs.some((m) => m.t === "denied"), "excluir votação avisa votantes");
x = await J(`/api/p/${poll.id}`); ok(x.r.status === 404, "poll excluída = 404");

adm.ws.close(); sm2.ws.close(); si.ws.close();
console.log(fails ? `\n${fails} falha(s)` : "\nTodos os testes passaram");
process.exit(fails ? 1 : 0);
