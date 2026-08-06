// Supabase Edge Function: выпуск и отзыв лицензий BIM.LVA.
//
// Это единственное место, где существует право выписать лицензию. Ключ подписи
// лежит в секретах функции и в браузер не попадает никогда — поэтому страницу
// админки можно держать на статическом сайте открыто: без админского JWT она
// ничего не выпустит.
//
// Развернуть:
//   Dashboard → Edge Functions → Create function "license-issue" → вставить →
//   Deploy. В настройках функции verify_jwt = true (по умолчанию).
//
// Секреты (Dashboard → Edge Functions → Secrets):
//   LICENSE_SIGNING_KEY — приватный ключ Ed25519, base64 от PKCS#8.
//                         Сгенерировать: node tools/make-license-keys.mjs
//   LICENSE_ISSUER      — необязательно, кто выпустил (по умолчанию BIM.LVA)
//
// Никаких списков админов в переменных окружения: админы лежат в таблице
// public.license_admins, туда пишет только владелец проекта через SQL Editor.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
// Формат ключа общий с проверкой — см. комментарий в license-format.js.
import { importSigningKey, signLicense } from "./license-format.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Сколько дней действует лицензия, если срок не указан явно. */
const DEFAULT_DAYS = 365;
const MAX_DAYS = 3650;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

async function loadSigningKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("LICENSE_SIGNING_KEY");
  if (!raw) throw new Error("LICENSE_SIGNING_KEY не задан в секретах функции");
  return await importSigningKey(raw);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Только POST" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Нужен вход" }, 401);

  // Кто зовёт: проверяем токен, а не то, что клиент про себя написал.
  const asUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  const caller = userData?.user;
  if (userErr || !caller) return json({ error: "Недействительный токен" }, 401);

  const admin = createClient(supabaseUrl, serviceKey);

  const { data: isAdmin } = await admin
    .from("license_admins")
    .select("user_id")
    .eq("user_id", caller.id)
    .maybeSingle();
  if (!isAdmin) return json({ error: "Недостаточно прав" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Ожидался JSON" }, 400);
  }

  const action = String(body.action ?? "");

  // ------------------------------------------------------------- выпуск ----
  if (action === "issue") {
    const requestId = String(body.requestId ?? "");
    if (!requestId) return json({ error: "Не указана заявка" }, 400);

    const days = Math.min(MAX_DAYS, Math.max(1, Number(body.days) || DEFAULT_DAYS));

    const { data: reqRow, error: reqErr } = await admin
      .from("license_requests")
      .select("id, user_id, email, product, org, status")
      .eq("id", requestId)
      .maybeSingle();
    if (reqErr || !reqRow) return json({ error: "Заявка не найдена" }, 404);
    if (reqRow.status === "approved") return json({ error: "Лицензия по этой заявке уже выдана" }, 409);

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + days * 86400_000);
    const licenseId = crypto.randomUUID();

    let licenseKey: string;
    try {
      licenseKey = await signLicense({
        v: 1,
        id: licenseId,
        p: reqRow.product,
        e: reqRow.email,
        o: reqRow.org ?? "",
        iss: Deno.env.get("LICENSE_ISSUER") ?? "BIM.LVA",
        iat: Math.floor(issuedAt.getTime() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
      }, await loadSigningKey());
    } catch (err) {
      return json({ error: `Подпись не удалась: ${err instanceof Error ? err.message : err}` }, 500);
    }

    const { error: insErr } = await admin.from("licenses").insert({
      id: licenseId,
      request_id: reqRow.id,
      user_id: reqRow.user_id,
      email: reqRow.email,
      org: reqRow.org ?? "",
      product: reqRow.product,
      license_key: licenseKey,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      issued_by: caller.id,
    });
    if (insErr) return json({ error: `Не удалось сохранить лицензию: ${insErr.message}` }, 500);

    await admin
      .from("license_requests")
      .update({
        status: "approved",
        decided_at: issuedAt.toISOString(),
        decided_by: caller.id,
        decision_note: String(body.note ?? ""),
      })
      .eq("id", reqRow.id);

    return json({ ok: true, licenseId, licenseKey, expiresAt: expiresAt.toISOString() });
  }

  // ------------------------------------------------------------- отказ -----
  if (action === "reject") {
    const requestId = String(body.requestId ?? "");
    if (!requestId) return json({ error: "Не указана заявка" }, 400);
    const { error } = await admin
      .from("license_requests")
      .update({
        status: "rejected",
        decided_at: new Date().toISOString(),
        decided_by: caller.id,
        decision_note: String(body.note ?? ""),
      })
      .eq("id", requestId)
      .eq("status", "new");
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ------------------------------------------------------------- отзыв -----
  // Офлайн-проверка про отзыв не узнает — ключ доработает до конца срока.
  // Отметка нужна, чтобы понимать, что происходит, и не продлевать.
  if (action === "revoke") {
    const licenseId = String(body.licenseId ?? "");
    if (!licenseId) return json({ error: "Не указана лицензия" }, 400);
    const { error } = await admin
      .from("licenses")
      .update({
        revoked_at: new Date().toISOString(),
        revoke_reason: String(body.note ?? ""),
      })
      .eq("id", licenseId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: `Неизвестное действие: ${action}` }, 400);
});
