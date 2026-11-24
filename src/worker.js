// Worker de entrada: autentica o administrador, serve os arquivos estáticos
// e encaminha API/WebSocket para o Durable Object "Hub" (tempo real).
export { Hub } from "./hub.js";

const enc = new TextEncoder();

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function adminToken(env) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.ADMIN_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("site-olimpiadas-admin-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEq(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// Token de usuário comum: "u.<id>.<hmac>" (assinado com a senha do administrador como chave)
async function userSig(env, id) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.ADMIN_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("olp-user-v1:" + id));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const userToken = async (env, id) => `u.${id}.${await userSig(env, id)}`;

// Quem está chamando: { admin: true } | { uid: "<id>" } | {}
async function whoAmI(request, url, env) {
  if (!env.ADMIN_PASSWORD) return {};
  const auth = request.headers.get("authorization") || "";
  const t = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token") || "";
  if (!t) return {};
  if (t.startsWith("u.")) {
    const [, id, sig] = t.split(".");
    if (id && sig && /^[0-9a-f-]{36}$/.test(id) && safeEq(sig, await userSig(env, id))) return { uid: id };
    return {};
  }
  return safeEq(t, await adminToken(env)) ? { admin: true } : {};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/api/admin/login" && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD não configurada no Worker." }, 500);
      let body = {};
      try { body = await request.json(); } catch {}
      if (!safeEq(String(body.password ?? ""), env.ADMIN_PASSWORD)) {
        await new Promise((r) => setTimeout(r, 400));
        return json({ error: "Senha incorreta." }, 401);
      }
      return json({ token: await adminToken(env) });
    }

    if (p === "/api/auth/config") return json({ needsCode: !!env.SIGNUP_CODE });

    // Conta de organizador: criar / entrar (a senha é guardada com PBKDF2 no Durable Object)
    if ((p === "/api/auth/register" || p === "/api/auth/login") && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD não configurada no Worker." }, 500);
      let body = {};
      try { body = await request.clone().json(); } catch {}
      if (p === "/api/auth/register" && env.SIGNUP_CODE && !safeEq(String(body.code ?? ""), String(env.SIGNUP_CODE)))
        return json({ error: "Código de convite incorreto." }, 403);
      const headers = new Headers(request.headers);
      headers.delete("x-admin-ok"); headers.delete("x-owner");
      const r = await env.HUB.get(env.HUB.idFromName("hub")).fetch(new Request(request, { headers }));
      if (!r.ok) {
        if (p === "/api/auth/login") await new Promise((res) => setTimeout(res, 400));
        return r;
      }
      const u = await r.json();
      return json({ ...u, token: await userToken(env, u.id) }, r.status);
    }

    const toHub = p.startsWith("/api/") || p.startsWith("/ws/") || p.startsWith("/img/") || p.startsWith("/pdf/");
    if (toHub) {
      const me = await whoAmI(request, url, env);
      if ((p.startsWith("/api/polls") || p.startsWith("/api/folders") || p === "/api/placement" || p === "/ws/admin") && !me.admin && !me.uid) return json({ error: "unauthorized" }, 401);
      const headers = new Headers(request.headers);
      headers.delete("x-admin-ok"); headers.delete("x-owner");
      if (me.admin) headers.set("x-admin-ok", "1");
      else if (me.uid) headers.set("x-owner", me.uid);
      const stub = env.HUB.get(env.HUB.idFromName("hub"));
      return stub.fetch(new Request(request, { headers }));
    }

    // Páginas
    if (p === "/admin" || p === "/admin/") return Response.redirect(new URL("/", url).toString(), 302);
    if (/^\/v\/[a-z0-9]+\/?$/.test(p)) return env.ASSETS.fetch(new Request(new URL("/v/", url), request));
    return env.ASSETS.fetch(request);
  },
};
