// ВНИМАНИЕ: файл собран автоматически из index.ts и license-lic.js.
// Не правьте его — правки затрёт следующая сборка. Меняйте исходники и
// выполняйте: npm run edge-bundle
//
// Эта версия нужна тем, кто разворачивает функцию через редактор в дашборде
// Supabase: там удобно вставить один файл. Через CLI разворачивайте обычные
// index.ts + license-lic.js — они и есть источник правды.
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
// Выпускает файл license.lic в том же формате, который проверяет
// LVA.BIM.Common/Licensing/LicenseGate.cs в плагинах: JSON {Payload, Signature},
// подпись RSA-SHA256 над канонической строкой. Контракт — в license-lic.js.
//
// Секреты (Dashboard → Edge Functions → Secrets):
//   LICENSE_SIGNING_KEY — приватный ключ RSA, base64 от PKCS#8.
//                         Сгенерировать: node tools/make-license-keys.mjs
//   LICENSE_ISSUER      — необязательно, кто выпустил (по умолчанию BIM.LVA)
//
// Никаких списков админов в переменных окружения: админы лежат в таблице
// public.license_admins, туда пишет только владелец проекта через SQL Editor.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
// Формат общий с тестами — см. комментарий в license-lic.js.
// ---- начало вклеенного license-lic.js ----
/**
 * Формат лицензии LVA BIM — тот, что уже понимают плагины.
 *
 * Контракт задан в репозитории LvaBim и повторён здесь один в один:
 *   LVA.BIM.Common/Licensing/LicenseModels.cs  → LicensePayload.ToCanonicalString()
 *   LVA.BIM.Common/Licensing/LicenseGate.cs    → VerifySignature (RSA-SHA256, PKCS#1 v1.5)
 *   Tools/New-LvaLicense.ps1                   → как это же делается в PowerShell
 *
 * Подписывается НЕ JSON, а плоская строка с фиксированным порядком полей —
 * именно потому, что сериализаторы на разных сторонах дают разный порядок и
 * формат. Любое расхождение здесь означает, что плагин отвергнет ключ у
 * клиента, а не у нас, поэтому каждая мелочь ниже объяснена.
 *
 * Обычный .js: его берут и Deno (Edge Function), и Node (тесты) без сборки.
 */

/**
 * Формат дат .NET "o" (round-trip): ровно 7 знаков после запятой.
 *
 * У JavaScript точность в миллисекундах, поэтому последние четыре знака —
 * нули. Это не косметика: C# читает JSON в DateTime, потом заново собирает
 * каноническую строку через ToString("o"). Запиши мы три знака вместо семи —
 * строка после разбора отличалась бы от подписанной, и подпись не сошлась бы.
 */
function toDotNetRoundTrip(date) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return (
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
        `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` +
        `.${pad(date.getUTCMilliseconds(), 3)}0000Z`
    );
}

/**
 * Каноническая строка — точная копия LicensePayload.ToCanonicalString().
 * Поля через «|», продукты через «,», отсутствующий срок — пустая строка.
 */
function canonicalString(payload) {
    const products = Array.isArray(payload.Products) ? payload.Products.join(',') : '';
    return [
        payload.LicenseId,
        payload.ClientName ?? '',
        products,
        payload.IssuedUtc,
        payload.ExpiresUtc ?? '',
        payload.HostLock ?? ''
    ].join('|');
}

function b64ToBytes(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

/** @param {string} b64 приватный ключ RSA, base64 от PKCS#8 */
async function importRsaSigningKey(b64) {
    return crypto.subtle.importKey(
        'pkcs8',
        b64ToBytes(b64),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );
}

/** @param {string} b64 публичный ключ RSA, base64 от SPKI */
async function importRsaVerifyKey(b64) {
    return crypto.subtle.importKey(
        'spki',
        b64ToBytes(b64),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
    );
}

/** Машинный отпечаток из LicenseGate: SHA-256 hex в верхнем регистре, 64 знака. */
function isMachineId(value) {
    return /^[0-9A-F]{64}$/i.test(String(value || '').trim());
}

/**
 * Собирает и подписывает лицензию. Возвращает объект LicenseFile —
 * ровно то, что клиент кладёт в %ProgramData%\LVA.BIM\license.lic.
 *
 * @param {object} o
 * @param {string} o.licenseId  GUID в формате «D» (со строчными буквами и дефисами)
 * @param {string} o.clientName кому выдана
 * @param {string[]} o.products «Civil» / «Navis» / «Inventor» либо ["*"]
 * @param {Date} o.issuedUtc
 * @param {Date|null} o.expiresUtc null — бессрочная
 * @param {string} o.hostLock    Machine ID клиента; пустая строка — без привязки
 */
async function signLicenseFile(o, signingKey) {
    const payload = {
        LicenseId: o.licenseId,
        ClientName: o.clientName ?? '',
        Products: o.products,
        IssuedUtc: toDotNetRoundTrip(o.issuedUtc),
        // В JSON у бессрочной лицензии стоит null, а в канонической строке —
        // пустая строка. Так делает и PowerShell-генератор.
        ExpiresUtc: o.expiresUtc ? toDotNetRoundTrip(o.expiresUtc) : null,
        HostLock: (o.hostLock ?? '').trim().toUpperCase()
    };

    const data = new TextEncoder().encode(canonicalString(payload));
    const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, signingKey, data)
    );

    return { Payload: payload, Signature: bytesToB64(sig) };
}

/**
 * Проверяет лицензию так же, как LicenseGate: подпись, срок, привязка, продукт.
 * Порядок вердиктов повторяет CheckInternal — чтобы причина отказа совпадала
 * с той, что увидит пользователь в плагине.
 */
async function verifyLicenseFile(file, verifyKey, { product, machineId, now = new Date() } = {}) {
    if (!file?.Payload || !file?.Signature) return { ok: false, status: 'Invalid' };

    const data = new TextEncoder().encode(canonicalString(file.Payload));
    let valid = false;
    try {
        valid = await crypto.subtle.verify(
            { name: 'RSASSA-PKCS1-v1_5' },
            verifyKey,
            b64ToBytes(file.Signature),
            data
        );
    } catch {
        return { ok: false, status: 'Invalid' };
    }
    if (!valid) return { ok: false, status: 'Invalid' };

    const expires = file.Payload.ExpiresUtc ? new Date(file.Payload.ExpiresUtc) : null;
    if (expires && expires < now) return { ok: false, status: 'Expired' };

    const lock = file.Payload.HostLock || '';
    if (lock && machineId && lock.toUpperCase() !== String(machineId).toUpperCase()) {
        return { ok: false, status: 'WrongMachine' };
    }

    if (product) {
        const list = file.Payload.Products || [];
        const covers = list.includes('*') ||
            list.some((p) => String(p).toLowerCase() === String(product).toLowerCase());
        if (!covers) return { ok: false, status: 'WrongProduct' };
    }

    return { ok: true, status: 'Valid' };
}
// ---- конец вклеенного license-lic.js ----

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
  return await importRsaSigningKey(raw);
}

/** Продукты, которые проверяются в коде плагинов. Ничего другого не бывает. */
const PRODUCTS = ["Civil", "Navis", "Inventor", "*"];

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

    // 0 дней = бессрочная лицензия: LicenseGate считает ExpiresUtc = null
    // действующей всегда, и такие вы выдавали PowerShell-скриптом.
    const days = Math.max(0, Math.min(MAX_DAYS, Number(body.days) ?? DEFAULT_DAYS));

    const { data: reqRow, error: reqErr } = await admin
      .from("license_requests")
      .select("id, user_id, email, product, org, full_name, machine_id, status")
      .eq("id", requestId)
      .maybeSingle();
    if (reqErr || !reqRow) return json({ error: "Заявка не найдена" }, 404);
    if (reqRow.status === "approved") return json({ error: "Лицензия по этой заявке уже выдана" }, 409);
    if (!PRODUCTS.includes(reqRow.product)) {
      return json({ error: `Неизвестный продукт «${reqRow.product}»` }, 400);
    }

    const hostLock = String(body.machineId ?? reqRow.machine_id ?? "").trim();
    // Пустой HostLock — лицензия без привязки к железу. Это осознанный выбор
    // выдающего, но случайный мусор вместо Machine ID пропускать нельзя:
    // плагин отвергнет такую лицензию как «выпущена для другого компьютера».
    if (hostLock && !isMachineId(hostLock)) {
      return json({ error: "Machine ID должен быть 64 шестнадцатеричными знаками" }, 400);
    }

    const issuedAt = new Date();
    const expiresAt = days > 0 ? new Date(issuedAt.getTime() + days * 86400_000) : null;
    const licenseId = crypto.randomUUID();

    // Имя клиента попадает в лицензию и видно в плагине — берём организацию,
    // а если её не указали, то ФИО или почту: пустое имя выглядит поломкой.
    const clientName = String(reqRow.org || reqRow.full_name || reqRow.email || "").trim();

    let licenseFile: unknown;
    try {
      licenseFile = await signLicenseFile({
        licenseId,
        clientName,
        products: [reqRow.product],
        issuedUtc: issuedAt,
        expiresUtc: expiresAt,
        hostLock,
      }, await loadSigningKey());
    } catch (err) {
      return json({ error: `Подпись не удалась: ${err instanceof Error ? err.message : err}` }, 500);
    }

    const licenseText = JSON.stringify(licenseFile, null, 2);

    const { error: insErr } = await admin.from("licenses").insert({
      id: licenseId,
      request_id: reqRow.id,
      user_id: reqRow.user_id,
      email: reqRow.email,
      org: reqRow.org ?? "",
      product: reqRow.product,
      machine_id: hostLock,
      license_key: licenseText,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt ? expiresAt.toISOString() : null,
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

    return json({
      ok: true,
      licenseId,
      licenseText,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
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
