// Supabase Edge Function: proxy Yandex Disk downloads (avoids browser CORS 403).
// Dashboard → Edge Functions → Create function "ya-proxy" → paste this → Deploy
// In function settings: disable JWT verification (verify_jwt = false) if using publishable key.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ALLOWED_HOSTS = new Set([
  "downloader.disk.yandex.ru",
  "downloader.disk.yandex.com",
  "storage.yandex.net",
]);

function hostAllowed(hostname: string) {
  if (ALLOWED_HOSTS.has(hostname)) return true;
  // s794sas.storage.yandex.net, s90nrg.storage.yandex.net, ...
  if (hostname.endsWith(".storage.yandex.net")) return true;
  if (hostname.endsWith(".disk.yandex.ru")) return true;
  return false;
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    const url = new URL(req.url);
    const target = url.searchParams.get("url");
    if (!target) {
      return new Response(JSON.stringify({ error: "missing url" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return new Response(JSON.stringify({ error: "bad url" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (!/^https?:$/.test(parsed.protocol) || !hostAllowed(parsed.hostname)) {
      return new Response(JSON.stringify({ error: "host not allowed" }), {
        status: 403,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Server-side fetch WITHOUT browser Origin → Yandex returns 302/200 instead of 403
    const upstream = await fetch(target, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 BIM-LVA-Composer",
        Accept: "*/*",
      },
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `upstream ${upstream.status}` }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const headers = new Headers(cors);
    headers.set(
      "Content-Type",
      upstream.headers.get("Content-Type") || "application/octet-stream",
    );
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    headers.set("Cache-Control", "no-store");

    return new Response(upstream.body, { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
