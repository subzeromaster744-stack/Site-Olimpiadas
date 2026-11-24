// Durable Object "Hub": guarda votações, participantes e votos (SQLite) e
// distribui eventos em tempo real por WebSocket (administrador e votantes).
import { DurableObject } from "cloudflare:workers";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
const rid = (n = 8) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => ALPHA[x % ALPHA.length]).join("");
const clean = (s, max) =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const DEFAULT_QUESTIONS = [
  "Solução do problema",
  "Impacto nos indicadores",
  "Criatividade / inovação",
  "Facilidade de replicação",
  "Custo-benefício",
  "Clareza do relatório",
];
const MAX_IMAGE = 1_900_000; // bytes (limite de linha do SQLite do DO é 2 MB)
const MAX_PARTICIPANTS = 3000;
const MAX_PDF = 20 * 1024 * 1024; // PDF completo da seção (guardado em pedaços)
const MAX_USERS = 1000;
const DEF_BIG = "10", DEF_SUB = "Anos · Olimpíadas"; // banner padrão (a imagem do banner fica em images com sec = -1)
const CHUNK = 1_500_000;           // cada linha do SQLite do DO aceita até 2 MB

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    const x = (q) => this.sql.exec(q);
    x(`CREATE TABLE IF NOT EXISTS polls (
         id TEXT PRIMARY KEY, rodada TEXT, categoria TEXT, turno TEXT, title TEXT,
         status TEXT NOT NULL DEFAULT 'open', sections TEXT NOT NULL, questions TEXT NOT NULL,
         created_at INTEGER NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS images (
         poll_id TEXT NOT NULL, sec INTEGER NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, ver INTEGER NOT NULL,
         PRIMARY KEY (poll_id, sec))`);
    x(`CREATE TABLE IF NOT EXISTS participants (
         id TEXT PRIMARY KEY, poll_id TEXT NOT NULL, name TEXT NOT NULL,
         joined_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active')`);
    x(`CREATE INDEX IF NOT EXISTS idx_part_poll ON participants(poll_id)`);
    x(`CREATE TABLE IF NOT EXISTS votes (
         pid TEXT NOT NULL, poll_id TEXT NOT NULL, sec INTEGER NOT NULL, q INTEGER NOT NULL, value INTEGER NOT NULL,
         PRIMARY KEY (pid, sec, q))`);
    x(`CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id)`);
    // migração: bancos criados antes da função "anular respostas" não têm a coluna
    if (!this.q("PRAGMA table_info(participants)").some((c) => c.name === "annulled"))
      x(`ALTER TABLE participants ADD COLUMN annulled INTEGER NOT NULL DEFAULT 0`);
    // migração: formulários passam a ter dono (NULL = criados antes das contas; só o administrador vê)
    if (!this.q("PRAGMA table_info(polls)").some((c) => c.name === "owner"))
      x(`ALTER TABLE polls ADD COLUMN owner TEXT`);
    // migração: texto do banner da página de votação
    if (!this.q("PRAGMA table_info(polls)").some((c) => c.name === "banner_big")) {
      x(`ALTER TABLE polls ADD COLUMN banner_big TEXT`);
      x(`ALTER TABLE polls ADD COLUMN banner_sub TEXT`);
    }
    x(`CREATE TABLE IF NOT EXISTS users (
         id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
         salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    x(`CREATE TABLE IF NOT EXISTS docs (
         poll_id TEXT NOT NULL, sec INTEGER NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, ver INTEGER NOT NULL,
         PRIMARY KEY (poll_id, sec))`);
    x(`CREATE TABLE IF NOT EXISTS doc_chunks (
         poll_id TEXT NOT NULL, sec INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL,
         PRIMARY KEY (poll_id, sec, idx))`);
  }

  dropDoc(pollId, minSec = 0) {
    this.sql.exec("DELETE FROM doc_chunks WHERE poll_id=? AND sec>=?", pollId, minSec);
    this.sql.exec("DELETE FROM docs WHERE poll_id=? AND sec>=?", pollId, minSec);
  }

  /* ------------------------------ contas ------------------------------ */
  async hashPw(password, saltHex) {
    const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async auth(path, request) {
    let b; try { b = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const username = String(b.username ?? "").trim().toLowerCase();
    const password = String(b.password ?? "");
    if (path === "/api/auth/register") {
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ error: "Usuário: 3 a 30 caracteres (letras, números, ponto, hífen ou _)." }, 400);
      if (username === "admin") return json({ error: "Esse usuário é reservado. Escolha outro." }, 400);
      if (password.length < 6 || password.length > 200) return json({ error: "A senha precisa ter pelo menos 6 caracteres." }, 400);
      if (this.q("SELECT 1 AS x FROM users WHERE username=?", username).length) return json({ error: "Esse usuário já existe. Escolha outro." }, 409);
      if (this.q("SELECT COUNT(*) AS n FROM users")[0].n >= MAX_USERS) return json({ error: "Limite de contas atingido." }, 429);
      const name = clean(b.name, 60) || username;
      const id = crypto.randomUUID();
      const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");
      this.sql.exec("INSERT INTO users (id, username, name, salt, hash, created_at) VALUES (?,?,?,?,?,?)",
        id, username, name, salt, await this.hashPw(password, salt), Date.now());
      return json({ id, username, name }, 201);
    }
    const u = this.q("SELECT * FROM users WHERE username=?", username)[0];
    // sempre faz o cálculo, para o tempo de resposta não revelar se o usuário existe
    const calc = await this.hashPw(password, u ? u.salt : "00".repeat(16));
    if (!u || calc !== u.hash) return json({ error: "Usuário ou senha incorretos." }, 401);
    return json({ id: u.id, username: u.username, name: u.name });
  }

  /* ------------------------------ helpers ------------------------------ */
  q(sql, ...b) { return this.sql.exec(sql, ...b).toArray(); }
  pollRow(id) { return this.q("SELECT * FROM polls WHERE id=?", id)[0]; }

  publicPoll(r, forAdmin = false) {
    const vers = {};
    for (const i of this.q("SELECT sec, ver FROM images WHERE poll_id=?", r.id)) vers[i.sec] = i.ver;
    const docs = {};
    for (const d of this.q("SELECT sec, name, size, ver FROM docs WHERE poll_id=?", r.id)) docs[d.sec] = d;
    const sections = JSON.parse(r.sections).map((s, i) => ({
      title: s.title,
      img: vers[i] != null ? `/img/${r.id}/${i}?v=${vers[i]}` : null,
      pdf: docs[i] ? `/pdf/${r.id}/${i}?v=${docs[i].ver}` : null,
      pdfName: docs[i]?.name ?? null,
      pdfSize: docs[i]?.size ?? null,
      // nome do competidor: só o organizador vê (quem vota não enxerga, para não influenciar)
      ...(forAdmin ? { competitor: s.competitor || "" } : {}),
    }));
    return {
      id: r.id, rodada: r.rodada, categoria: r.categoria, turno: r.turno, title: r.title,
      status: r.status, sections, questions: JSON.parse(r.questions),
      banner: { big: r.banner_big ?? DEF_BIG, sub: r.banner_sub ?? DEF_SUB, img: vers[-1] != null ? `/img/${r.id}/-1?v=${vers[-1]}` : null },
    };
  }

  onlineMap(pollId, exclude) {
    const m = new Map();
    for (const ws of this.ctx.getWebSockets("p:" + pollId)) {
      if (ws === exclude) continue;
      const a = ws.deserializeAttachment();
      if (a?.pid) m.set(a.pid, (m.get(a.pid) || 0) + 1);
    }
    return m;
  }

  participants(r, exclude) {
    const total = JSON.parse(r.sections).length * JSON.parse(r.questions).length;
    const online = this.onlineMap(r.id, exclude);
    return this.q(
      `SELECT p.id, p.name, p.joined_at, p.status, p.annulled,
              (SELECT COUNT(*) FROM votes v WHERE v.pid = p.id) AS answered
         FROM participants p WHERE p.poll_id=? ORDER BY p.joined_at`, r.id,
    ).map((p) => ({ ...p, total, online: online.has(p.id) }));
  }

  results(pollId) {
    const cells = {};
    for (const c of this.q(
      `SELECT v.sec, v.q, AVG(v.value) AS avg, COUNT(*) AS n
         FROM votes v JOIN participants p ON p.id = v.pid
        WHERE v.poll_id=? AND p.status='active' AND p.annulled=0 GROUP BY v.sec, v.q`, pollId,
    )) cells[`${c.sec}_${c.q}`] = { avg: c.avg, n: c.n };
    const respondents = this.q(
      `SELECT COUNT(DISTINCT v.pid) AS n FROM votes v JOIN participants p ON p.id=v.pid
        WHERE v.poll_id=? AND p.status='active' AND p.annulled=0`, pollId)[0].n;
    return { cells, respondents };
  }

  adminPoll(r, exclude) {
    return { ...this.publicPoll(r, true), participants: this.participants(r, exclude), results: this.results(r.id) };
  }

  // owner: dono do formulário. O administrador (tag "all") recebe tudo; cada organizador só o que é dele.
  toAdmins(msg, owner) {
    const s = JSON.stringify(msg);
    const targets = new Set(this.ctx.getWebSockets("all"));
    if (owner && owner !== "admin") for (const ws of this.ctx.getWebSockets("own:" + owner)) targets.add(ws);
    for (const ws of targets) { try { ws.send(s); } catch {} }
  }
  toVoters(pollId, msg, only) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets("p:" + pollId)) {
      if (only && ws.deserializeAttachment()?.pid !== only) continue;
      try { ws.send(s); } catch {}
    }
  }
  pushLive(pollId, exclude) {
    const r = this.pollRow(pollId);
    if (!r) return;
    this.toAdmins({ t: "live", poll: pollId, participants: this.participants(r, exclude), results: this.results(pollId) }, r.owner);
  }
  pushPoll(pollId) {
    const r = this.pollRow(pollId);
    if (!r) return;
    this.toAdmins({ t: "poll", poll: this.adminPoll(r) }, r.owner);
    this.toVoters(pollId, { t: "poll", poll: this.publicPoll(r) });
  }

  parsePoll(b) {
    const rodada = clean(b.rodada, 30) || "1° Rodada";
    const categoria = clean(b.categoria, 40) || "Geral";
    const turno = clean(b.turno, 30);
    let sections = Array.isArray(b.sections)
      ? b.sections.slice(0, 12).map((s) => ({ title: clean(typeof s === "string" ? s : s?.title, 120), competitor: clean(typeof s === "string" ? "" : s?.competitor, 80) }))
      : [];
    if (!sections.length) sections = Array.from({ length: 4 }, () => ({ title: "", competitor: "" }));
    let questions = Array.isArray(b.questions) ? b.questions.map((x) => clean(x, 160)).filter(Boolean).slice(0, 20) : [];
    if (!questions.length) questions = DEFAULT_QUESTIONS;
    const title = clean(b.title, 120) || [rodada, categoria, turno].filter(Boolean).join(" ");
    const bannerBig = b.bannerBig === undefined ? DEF_BIG : clean(b.bannerBig, 12);
    const bannerSub = b.bannerSub === undefined ? DEF_SUB : clean(b.bannerSub, 40);
    return { rodada, categoria, turno, title, sections, questions, bannerBig, bannerSub };
  }

  /* ------------------------------ HTTP ------------------------------ */
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const admin = request.headers.get("x-admin-ok") === "1";
    const uid = request.headers.get("x-owner") || "";
    let m;

    if ((path === "/api/auth/register" || path === "/api/auth/login") && method === "POST") return this.auth(path, request);

    if (path === "/ws/admin") {
      if (!admin && !uid) return json({ error: "unauthorized" }, 401);
      return this.acceptAdmin(request, admin, uid);
    }
    if ((m = path.match(/^\/ws\/p\/([a-z0-9]+)$/))) return this.acceptVoter(request, m[1], url.searchParams.get("token"));

    if ((m = path.match(/^\/img\/([a-z0-9]+)\/(-?\d+)$/))) {
      const img = this.q("SELECT mime, data FROM images WHERE poll_id=? AND sec=?", m[1], Number(m[2]))[0];
      if (!img) return new Response("not found", { status: 404 });
      return new Response(img.data, {
        headers: { "content-type": img.mime, "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if ((m = path.match(/^\/pdf\/([a-z0-9]+)\/(\d+)$/))) {
      const pollId = m[1], sec = Number(m[2]);
      const doc = this.q("SELECT name, size FROM docs WHERE poll_id=? AND sec=?", pollId, sec)[0];
      if (!doc) return new Response("not found", { status: 404 });
      const ids = this.q("SELECT idx FROM doc_chunks WHERE poll_id=? AND sec=? ORDER BY idx", pollId, sec).map((r) => r.idx);
      let n = 0;
      const body = new ReadableStream({
        pull: (ctrl) => {
          if (n >= ids.length) return ctrl.close();
          const row = this.q("SELECT data FROM doc_chunks WHERE poll_id=? AND sec=? AND idx=?", pollId, sec, ids[n++])[0];
          ctrl.enqueue(new Uint8Array(row.data));
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "application/pdf",
          "content-length": String(doc.size),
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
          "x-content-type-options": "nosniff",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if ((m = path.match(/^\/api\/p\/([a-z0-9]+)$/)) && method === "GET") {
      const r = this.pollRow(m[1]);
      return r ? json(this.publicPoll(r)) : json({ error: "not_found" }, 404);
    }
    if ((m = path.match(/^\/api\/p\/([a-z0-9]+)\/join$/)) && method === "POST") return this.join(m[1], request);

    if (!admin && !uid) return json({ error: "unauthorized" }, 401);
    const mine = (r) => admin || r.owner === uid;

    // qualquer rota de um formulário de outra pessoa responde como se ele não existisse
    if ((m = path.match(/^\/api\/polls\/([a-z0-9]+)(\/|$)/))) {
      const r = this.pollRow(m[1]);
      if (r && !mine(r)) return json({ error: "not_found" }, 404);
    }

    if (path === "/api/polls" && method === "GET")
      return json(this.listPolls(admin, uid).map((r) => this.adminPoll(r)));

    if (path === "/api/polls" && method === "POST") {
      let b; try { b = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
      const d = this.parsePoll(b);
      const id = rid(8);
      this.sql.exec(
        `INSERT INTO polls (id, rodada, categoria, turno, title, status, sections, questions, created_at, owner, banner_big, banner_sub)
         VALUES (?,?,?,?,?,'open',?,?,?,?,?,?)`,
        id, d.rodada, d.categoria, d.turno, d.title, JSON.stringify(d.sections), JSON.stringify(d.questions), Date.now(), admin ? "admin" : uid, d.bannerBig, d.bannerSub);
      const row = this.pollRow(id);
      const poll = this.adminPoll(row);
      this.toAdmins({ t: "poll", poll }, row.owner);
      return json(poll, 201);
    }

    if ((m = path.match(/^\/api\/polls\/([a-z0-9]+)$/))) {
      const id = m[1];
      const r = this.pollRow(id);
      if (!r) return json({ error: "not_found" }, 404);
      if (method === "PUT") {
        let b; try { b = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
        const d = this.parsePoll({ ...JSON.parse(JSON.stringify({
          rodada: r.rodada, categoria: r.categoria, turno: r.turno, title: r.title,
          sections: JSON.parse(r.sections), questions: JSON.parse(r.questions),
          bannerBig: r.banner_big ?? DEF_BIG, bannerSub: r.banner_sub ?? DEF_SUB })), ...b });
        const status = b.status === "closed" ? "closed" : b.status === "open" ? "open" : r.status;
        this.sql.exec(
          "UPDATE polls SET rodada=?, categoria=?, turno=?, title=?, status=?, sections=?, questions=?, banner_big=?, banner_sub=? WHERE id=?",
          d.rodada, d.categoria, d.turno, d.title, status, JSON.stringify(d.sections), JSON.stringify(d.questions), d.bannerBig, d.bannerSub, id);
        this.sql.exec("DELETE FROM votes WHERE poll_id=? AND (sec>=? OR q>=?)", id, d.sections.length, d.questions.length);
        this.sql.exec("DELETE FROM images WHERE poll_id=? AND sec>=?", id, d.sections.length);
        this.dropDoc(id, d.sections.length);
        this.pushPoll(id);
        return json({ ok: true });
      }
      if (method === "DELETE") {
        this.toVoters(id, { t: "denied", reason: "deleted" });
        for (const ws of this.ctx.getWebSockets("p:" + id)) { try { ws.close(4404, "deleted"); } catch {} }
        for (const t of ["votes", "participants", "images"]) this.sql.exec(`DELETE FROM ${t} WHERE poll_id=?`, id);
        this.dropDoc(id);
        this.sql.exec("DELETE FROM polls WHERE id=?", id);
        this.toAdmins({ t: "deleted", poll: id }, r.owner);
        return json({ ok: true });
      }
    }

    if ((m = path.match(/^\/api\/polls\/([a-z0-9]+)\/image\/(-?\d+)$/))) {
      const id = m[1], sec = Number(m[2]);
      const r = this.pollRow(id);
      if (!r) return json({ error: "not_found" }, 404);
      if (sec < -1 || sec >= JSON.parse(r.sections).length) return json({ error: "bad_section" }, 400); // -1 = banner
      if (method === "PUT") {
        const mime = (request.headers.get("content-type") || "").split(";")[0].trim();
        if (!/^image\/(jpeg|png|webp)$/.test(mime)) return json({ error: "Use JPEG, PNG ou WebP." }, 415);
        const buf = await request.arrayBuffer();
        if (!buf.byteLength || buf.byteLength > MAX_IMAGE) return json({ error: "Imagem vazia ou maior que 1,9 MB." }, 413);
        this.sql.exec("INSERT OR REPLACE INTO images (poll_id, sec, mime, data, ver) VALUES (?,?,?,?,?)", id, sec, mime, buf, Date.now());
        this.pushPoll(id);
        return json({ ok: true });
      }
      if (method === "DELETE") {
        this.sql.exec("DELETE FROM images WHERE poll_id=? AND sec=?", id, sec);
        this.pushPoll(id);
        return json({ ok: true });
      }
    }

    if ((m = path.match(/^\/api\/polls\/([a-z0-9]+)\/pdf\/(\d+)$/))) {
      const id = m[1], sec = Number(m[2]);
      const r = this.pollRow(id);
      if (!r) return json({ error: "not_found" }, 404);
      if (sec >= JSON.parse(r.sections).length) return json({ error: "bad_section" }, 400);
      if (method === "PUT") {
        const buf = new Uint8Array(await request.arrayBuffer());
        if (!buf.byteLength || buf.byteLength > MAX_PDF) return json({ error: "PDF vazio ou maior que 20 MB." }, 413);
        if (String.fromCharCode(...buf.subarray(0, 5)) !== "%PDF-") return json({ error: "O arquivo não é um PDF válido." }, 415);
        let name = "documento.pdf";
        try { name = clean(decodeURIComponent(request.headers.get("x-filename") || ""), 120) || name; } catch {}
        const ver = Date.now();
        this.ctx.storage.transactionSync(() => {
          this.sql.exec("DELETE FROM doc_chunks WHERE poll_id=? AND sec=?", id, sec);
          this.sql.exec("DELETE FROM docs WHERE poll_id=? AND sec=?", id, sec);
          for (let i = 0, off = 0; off < buf.byteLength; i++, off += CHUNK)
            this.sql.exec("INSERT INTO doc_chunks (poll_id, sec, idx, data) VALUES (?,?,?,?)", id, sec, i, buf.slice(off, off + CHUNK));
          this.sql.exec("INSERT INTO docs (poll_id, sec, name, size, ver) VALUES (?,?,?,?,?)", id, sec, name, buf.byteLength, ver);
        });
        this.pushPoll(id);
        return json({ ok: true });
      }
      if (method === "DELETE") {
        this.sql.exec("DELETE FROM doc_chunks WHERE poll_id=? AND sec=?", id, sec);
        this.sql.exec("DELETE FROM docs WHERE poll_id=? AND sec=?", id, sec);
        this.pushPoll(id);
        return json({ ok: true });
      }
    }

    if ((m = path.match(/^\/api\/polls\/([a-z0-9]+)\/participants\/([0-9a-f-]{36})\/(kick|unkick|annul|restore)$/)) && method === "POST") {
      const [, id, pid, action] = m;
      const p = this.q("SELECT * FROM participants WHERE id=? AND poll_id=?", pid, id)[0];
      if (!p) return json({ error: "not_found" }, 404);
      if (action === "kick" || action === "unkick")
        this.sql.exec("UPDATE participants SET status=? WHERE id=?", action === "kick" ? "kicked" : "active", pid);
      else // anular: as notas ficam guardadas, mas não entram nos resultados; restaurar volta a contar
        this.sql.exec("UPDATE participants SET annulled=? WHERE id=?", action === "annul" ? 1 : 0, pid);
      if (action === "kick") this.kickSockets(id, pid);
      this.pushLive(id);
      return json({ ok: true });
    }

    // apagar a pessoa da lista (e as respostas dela); o nome deixa de estar bloqueado
    if ((m = path.match(/^\/api\/polls\/([a-z0-9]+)\/participants\/([0-9a-f-]{36})$/)) && method === "DELETE") {
      const [, id, pid] = m;
      if (!this.q("SELECT 1 AS x FROM participants WHERE id=? AND poll_id=?", pid, id).length) return json({ error: "not_found" }, 404);
      this.deleteParticipants(id, [pid]);
      return json({ ok: true });
    }
    if (path.match(/^\/api\/polls\/([a-z0-9]+)\/kicked$/) && method === "DELETE") {
      const id = path.split("/")[3];
      if (!this.pollRow(id)) return json({ error: "not_found" }, 404);
      const ids = this.q("SELECT id FROM participants WHERE poll_id=? AND status='kicked'", id).map((r) => r.id);
      this.deleteParticipants(id, ids);
      return json({ ok: true, deleted: ids.length });
    }

    if ((m = path.match(/^\/api\/polls\/([a-z0-9]+)\/export\.csv$/)) && method === "GET") {
      const r = this.pollRow(m[1]);
      if (!r) return json({ error: "not_found" }, 404);
      const secs = JSON.parse(r.sections), qs = JSON.parse(r.questions);
      const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const rows = [["votacao", "participante", "situacao", "secao", "titulo_secao", "pergunta", "nota"]];
      for (const v of this.q(
        `SELECT p.name, p.status, p.annulled, v.sec, v.q, v.value FROM votes v JOIN participants p ON p.id=v.pid
          WHERE v.poll_id=? ORDER BY p.joined_at, v.sec, v.q`, r.id))
        rows.push([r.title, v.name, v.status === "kicked" ? "expulso" : v.annulled ? "anulado" : "ativo", v.sec + 1, secs[v.sec]?.title ?? "", qs[v.q] ?? "", v.value]);
      return new Response("﻿" + rows.map((x) => x.map(esc).join(";")).join("\n"), {
        headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="votos-${r.id}.csv"` },
      });
    }

    return json({ error: "not_found" }, 404);
  }

  listPolls(admin, uid) {
    return admin
      ? this.q("SELECT * FROM polls ORDER BY created_at DESC")
      : this.q("SELECT * FROM polls WHERE owner=? ORDER BY created_at DESC", uid);
  }

  async join(pollId, request) {
    const r = this.pollRow(pollId);
    if (!r) return json({ error: "not_found" }, 404);
    let b = {}; try { b = await request.json(); } catch {}
    const token = String(b.token || "");
    if (token) {
      const p = this.q("SELECT * FROM participants WHERE id=? AND poll_id=?", token, pollId)[0];
      if (p) {
        if (p.status === "kicked") return json({ error: "kicked" }, 403);
        return json({ token: p.id, name: p.name });
      }
    }
    const name = clean(b.name, 60);
    if (name.length < 2) return json({ error: "Informe seu nome (mínimo 2 letras)." }, 400);
    if (r.status !== "open") return json({ error: "closed" }, 403);
    if (this.q("SELECT 1 AS x FROM participants WHERE poll_id=? AND status='kicked' AND lower(name)=lower(?)", pollId, name).length)
      return json({ error: "kicked" }, 403);
    if (this.q("SELECT COUNT(*) AS n FROM participants WHERE poll_id=?", pollId)[0].n >= MAX_PARTICIPANTS)
      return json({ error: "Limite de participantes atingido." }, 429);
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO participants (id, poll_id, name, joined_at) VALUES (?,?,?,?)", id, pollId, name, Date.now());
    this.pushLive(pollId);
    return json({ token: id, name });
  }

  deleteParticipants(pollId, pids) {
    for (const pid of pids) {
      // se ainda estiver conectado, volta para a tela de nome (o token deixa de existir)
      for (const ws of this.ctx.getWebSockets("p:" + pollId)) {
        if (ws.deserializeAttachment()?.pid !== pid) continue;
        try { ws.send(JSON.stringify({ t: "denied", reason: "removed" })); ws.close(4401, "removed"); } catch {}
      }
      this.sql.exec("DELETE FROM votes WHERE pid=?", pid);
      this.sql.exec("DELETE FROM participants WHERE id=? AND poll_id=?", pid, pollId);
    }
    this.pushLive(pollId);
  }

  kickSockets(pollId, pid) {
    for (const ws of this.ctx.getWebSockets("p:" + pollId)) {
      if (ws.deserializeAttachment()?.pid !== pid) continue;
      try { ws.send(JSON.stringify({ t: "kicked" })); ws.close(4403, "kicked"); } catch {}
    }
  }

  /* ------------------------------ WebSocket ------------------------------ */
  acceptAdmin(request, admin, uid) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, admin ? ["all"] : ["own:" + uid]);
    server.send(JSON.stringify({ t: "init", polls: this.listPolls(admin, uid).map((r) => this.adminPoll(r)) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  acceptVoter(request, pollId, token) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["p:" + pollId]);
    const r = this.pollRow(pollId);
    const p = r && token ? this.q("SELECT * FROM participants WHERE id=? AND poll_id=?", String(token), pollId)[0] : null;
    if (!r) { server.send(JSON.stringify({ t: "denied", reason: "deleted" })); server.close(4404, "not found"); }
    else if (!p) { server.send(JSON.stringify({ t: "denied", reason: "invalid" })); server.close(4401, "invalid"); }
    else if (p.status === "kicked") { server.send(JSON.stringify({ t: "kicked" })); server.close(4403, "kicked"); }
    else {
      server.serializeAttachment({ pid: p.id });
      const votes = {};
      for (const v of this.q("SELECT sec, q, value FROM votes WHERE pid=?", p.id)) votes[`${v.sec}_${v.q}`] = v.value;
      server.send(JSON.stringify({ t: "hello", poll: this.publicPoll(r), name: p.name, votes }));
      this.pushLive(pollId);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.t === "ping") { try { ws.send('{"t":"pong"}'); } catch {} return; }
    if (!this.ctx.getTags(ws).some((t) => t.startsWith("p:"))) return; // painel só escuta
    const a = ws.deserializeAttachment();
    if (!a?.pid || msg?.t !== "vote") return;

    const p = this.q(
      `SELECT p.status AS pstatus, p.poll_id, l.status AS lstatus, l.sections, l.questions
         FROM participants p JOIN polls l ON l.id = p.poll_id WHERE p.id=?`, a.pid)[0];
    if (!p) { ws.send('{"t":"denied","reason":"deleted"}'); return; }
    if (p.pstatus !== "active") { ws.send('{"t":"kicked"}'); try { ws.close(4403, "kicked"); } catch {} return; }
    if (p.lstatus !== "open") { ws.send('{"t":"closed"}'); return; }

    const sec = Number(msg.sec), q = Number(msg.q), value = Number(msg.value);
    if (!Number.isInteger(sec) || !Number.isInteger(q) || !Number.isInteger(value)) return;
    if (value < 1 || value > 5) return;
    if (sec < 0 || sec >= JSON.parse(p.sections).length || q < 0 || q >= JSON.parse(p.questions).length) return;

    this.sql.exec("INSERT OR REPLACE INTO votes (pid, poll_id, sec, q, value) VALUES (?,?,?,?,?)", a.pid, p.poll_id, sec, q, value);
    ws.send(JSON.stringify({ t: "ack", sec, q, value }));
    this.pushLive(p.poll_id);
  }

  webSocketClose(ws) { this.onGone(ws); try { ws.close(); } catch {} }
  webSocketError(ws) { this.onGone(ws); }
  onGone(ws) {
    const tag = this.ctx.getTags(ws).find((t) => t.startsWith("p:"));
    if (tag && ws.deserializeAttachment()?.pid) this.pushLive(tag.slice(2), ws);
  }
}
