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

/**
 * Что умеет эта версия функции. Список возвращается в ответе на неизвестное
 * действие: «Неизвестное действие: import» сам по себе не говорит, старая в
 * дашборде версия или опечатка в клиенте, — а список говорит сразу.
 */
const ACTIONS = ["issue", "import", "reject", "revoke"];

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

  // -------------------------------------------------- импорт офлайн-ключа ---
  // Учёт лицензий, выданных Tools\New-LvaLicense.ps1 (сертификат «LVA Code
  // Signing», не веб-ключ) — чтобы админ видел их в «Выданные лицензии»
  // наравне с выпущенными через сайт. Подпись не перепроверяем: доверяем
  // тому, что вставляет сам админ. Аккаунт получателя необязателен — если
  // человека с таким email в кабинете нет, лицензия всё равно сохраняется
  // (user_id = null), просто не попадёт в его «Мои заявки», пока он не
  // зарегистрируется с этим же email.
  if (action === "import") {
    const email = String(body.email ?? "").trim().toLowerCase();
    const licenseText = String(body.licenseText ?? "").trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "Укажите корректный email получателя" }, 400);
    }
    if (!licenseText) return json({ error: "Вставьте содержимое license.lic" }, 400);

    let parsed: { Payload: Record<string, unknown> };
    try {
      parsed = parseLicenseFile(licenseText) as { Payload: Record<string, unknown> };
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const products = parsed.Payload.Products as string[];
    const unknown = products.find((p) => !PRODUCTS.includes(p));
    if (unknown) {
      return json({ error: `Неизвестный продукт «${unknown}» — бывают только Civil, Navis, Inventor, *` }, 400);
    }

    // Ищем аккаунт получателя по email — best-effort, не блокирует импорт.
    // listUsers без email-фильтра (не во всех версиях SDK есть) — при
    // тысячах пользователей потребует постраничный обход, но пока проект
    // только запускается, одной страницы с запасом достаточно.
    let targetUserId: string | null = null;
    let targetEmail = email;
    const { data: usersPage, error: listErr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) return json({ error: `Не удалось прочитать список пользователей: ${listErr.message}` }, 500);
    const found = usersPage?.users?.find((u) => (u.email ?? "").toLowerCase() === email);
    if (found) {
      targetUserId = found.id;
      targetEmail = found.email ?? email;
    }

    const issuedAt = parsed.Payload.IssuedUtc ? new Date(String(parsed.Payload.IssuedUtc)) : new Date();
    const expiresAt = parsed.Payload.ExpiresUtc ? new Date(String(parsed.Payload.ExpiresUtc)) : null;
    const org = String(parsed.Payload.ClientName ?? "").trim();
    const licenseId = String(parsed.Payload.LicenseId ?? "");

    // Одна лицензия может закрывать несколько продуктов, а строка в таблице —
    // всегда один (так же, как при обычной выдаче через issue). Первая строка
    // берёт «родной» LicenseId файла, остальные — новые, иначе конфликт PK.
    const rows = products.map((product, i) => ({
      id: i === 0 && licenseId ? licenseId : crypto.randomUUID(),
      request_id: null,
      user_id: targetUserId,
      email: targetEmail,
      org,
      product,
      machine_id: String(parsed.Payload.HostLock ?? ""),
      license_key: licenseText,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      issued_by: caller.id,
    }));

    const { error: insErr } = await admin.from("licenses").insert(rows);
    if (insErr) return json({ error: `Не удалось сохранить: ${insErr.message}` }, 500);

    return json({
      ok: true,
      imported: rows.length,
      linkedToAccount: !!targetUserId,
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

  // Список — это то, что умеет ИМЕННО развёрнутая версия. Видите в ответе
  // действие, которого ждали, — дело в клиенте; не видите — в дашборде лежит
  // старый bundled.ts, и надо вставить свежий.
  return json({
    error: `Неизвестное действие: ${action}. Эта версия функции умеет: ${ACTIONS.join(", ")}.`,
    supportedActions: ACTIONS,
  }, 400);
});
