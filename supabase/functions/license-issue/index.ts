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
import { importRsaSigningKey, signLicenseFile, isMachineId, parseLicenseFile } from "./license-lic.js";

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

  // ------------------------------------------------------------ импорт -----
  // Учёт лицензии, выданной офлайн-скриптом Tools\New-LvaLicense.ps1. Такие
  // ключи уже работают у клиентов, но в базе их нет — список в кабинете
  // выглядит пустым. Здесь ничего не подписывается: файл принимается как есть,
  // разбираются только поля. Подпись проверять нечем и незачем — офлайн-ключи
  // подписаны сертификатом «LVA Code Signing», публичной части которого на
  // сервере нет, а настоящую проверку всё равно делает плагин у клиента.
  if (action === "import") {
    let parsed: ReturnType<typeof parseLicenseFile>;
    try {
      parsed = parseLicenseFile(body.licenseText ?? body.license ?? "");
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const unknown = parsed.products.filter((p: string) => !PRODUCTS.includes(p));
    if (unknown.length) {
      return json({ error: `Неизвестный продукт «${unknown.join(", ")}»` }, 400);
    }
    // Одна строка учёта = один продукт: так устроена колонка product и так же
    // ведёт себя выпуск через сайт. Комплект «*» — это тоже одно значение.
    if (parsed.products.length > 1) {
      return json({
        error: "В файле несколько продуктов. Учтите их отдельными лицензиями или используйте комплект «*».",
      }, 400);
    }

    const email = String(body.email ?? "").trim().toLowerCase();

    // Кому принадлежит лицензия. Аккаунт больше не обязателен (миграция
    // 20260812180000), но если он есть — привяжем, чтобы человек увидел ключ в
    // своём кабинете. Ищем без обращения к auth.users: по уже известным нам
    // строкам заявок и лицензий.
    let ownerId: string | null = null;
    if (email && email === String(caller.email ?? "").toLowerCase()) {
      ownerId = caller.id;
    } else if (email) {
      const { data: byReq } = await admin
        .from("license_requests")
        .select("user_id")
        .eq("email", email)
        .not("user_id", "is", null)
        .limit(1)
        .maybeSingle();
      ownerId = byReq?.user_id ?? null;
      if (!ownerId) {
        const { data: byLic } = await admin
          .from("licenses")
          .select("user_id")
          .eq("email", email)
          .not("user_id", "is", null)
          .limit(1)
          .maybeSingle();
        ownerId = byLic?.user_id ?? null;
      }
    }

    // LicenseId из файла — естественный ключ: повторный импорт того же файла
    // не должен плодить дубли. Если он не UUID (лицензия из другого
    // генератора), берём свой — тогда защита от дублей делается по машине.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(parsed.licenseId);
    const rowId = isUuid ? parsed.licenseId.toLowerCase() : crypto.randomUUID();

    if (isUuid) {
      const { data: dup } = await admin
        .from("licenses")
        .select("id")
        .eq("id", rowId)
        .maybeSingle();
      if (dup) return json({ error: "Эта лицензия уже учтена." }, 409);
    }

    const licenseText = JSON.stringify(
      { Payload: parsed.payload, Signature: parsed.signature },
      null,
      2,
    );

    const { error: insErr } = await admin.from("licenses").insert({
      id: rowId,
      request_id: null,
      user_id: ownerId,
      email: email || parsed.clientName,
      org: parsed.clientName,
      product: parsed.products[0],
      machine_id: parsed.hostLock,
      license_key: licenseText,
      issued_at: new Date(parsed.issuedUtc).toISOString(),
      expires_at: parsed.expiresUtc ? new Date(parsed.expiresUtc).toISOString() : null,
      issued_by: caller.id,
    });
    if (insErr) return json({ error: `Не удалось учесть лицензию: ${insErr.message}` }, 500);

    return json({
      ok: true,
      licenseId: rowId,
      product: parsed.products[0],
      clientName: parsed.clientName,
      machineId: parsed.hostLock,
      linkedToAccount: !!ownerId,
      expiresAt: parsed.expiresUtc ? new Date(parsed.expiresUtc).toISOString() : null,
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
