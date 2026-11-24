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

async function isAdmin(request, url, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("authorization") || "";
  const t = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token") || "";
  if (!t) return false;
  return safeEq(t, await adminToken(env));
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

    const toHub = p.startsWith("/api/") || p.startsWith("/ws/") || p.startsWith("/img/");
    if (toHub) {
      const admin = await isAdmin(request, url, env);
      if ((p.startsWith("/api/polls") || p === "/ws/admin") && !admin) return json({ error: "unauthorized" }, 401);
      const headers = new Headers(request.headers);
      headers.delete("x-admin-ok");
      if (admin) headers.set("x-admin-ok", "1");
      const stub = env.HUB.get(env.HUB.idFromName("hub"));
      return stub.fetch(new Request(request, { headers }));
    }

    // Páginas
    if (p === "/admin" || p === "/admin/") return env.ASSETS.fetch(new Request(new URL("/admin/", url), request));
    if (/^\/v\/[a-z0-9]+\/?$/.test(p)) return env.ASSETS.fetch(new Request(new URL("/v/", url), request));
    return env.ASSETS.fetch(request);
  },
};
