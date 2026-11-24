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

// encerrar
x = await J(`/api/polls/${poll.id}`, { method: "PUT", headers: AH, body: JSON.stringify({ status: "closed" }) });
sm2.ws.send(JSON.stringify({ t: "vote", sec: 0, q: 3, value: 2 })); await sleep(300);
ok(sm2.msgs.some((m) => m.t === "closed"), "voto após encerrar é recusado");
x = await J(`/api/p/${poll.id}/join`, { method: "POST", body: JSON.stringify({ name: "Novo Aluno" }) });
ok(x.r.status === 403 && x.b.error === "closed", "novas entradas bloqueadas quando encerrada");

// csv
const csv = await fetch(`${BASE}/api/polls/${poll.id}/export.csv`, { headers: { authorization: "Bearer " + T } });
ok(csv.status === 200 && (await csv.text()).includes("Maria Silva"), "exportar CSV");

// páginas
for (const [p, s] of [["/", 200], ["/admin", 200], [`/v/${poll.id}`, 200]]) { const r = await fetch(BASE + p); ok(r.status === s, `GET ${p} = ${r.status}`); }

// excluir
x = await J(`/api/polls/${poll.id}`, { method: "DELETE", headers: AH }); await sleep(300);
ok(x.r.status === 200 && sm2.msgs.some((m) => m.t === "denied"), "excluir votação avisa votantes");
x = await J(`/api/p/${poll.id}`); ok(x.r.status === 404, "poll excluída = 404");

adm.ws.close(); sm2.ws.close(); si.ws.close();
console.log(fails ? `\n${fails} falha(s)` : "\nTodos os testes passaram");
process.exit(fails ? 1 : 0);
