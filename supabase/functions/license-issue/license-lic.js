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
export function toDotNetRoundTrip(date) {
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
export function canonicalString(payload) {
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
export async function importRsaSigningKey(b64) {
    return crypto.subtle.importKey(
        'pkcs8',
        b64ToBytes(b64),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    );
}

/** @param {string} b64 публичный ключ RSA, base64 от SPKI */
export async function importRsaVerifyKey(b64) {
    return crypto.subtle.importKey(
        'spki',
        b64ToBytes(b64),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
    );
}

/** Машинный отпечаток из LicenseGate: SHA-256 hex в верхнем регистре, 64 знака. */
export function isMachineId(value) {
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
export async function signLicenseFile(o, signingKey) {
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
 * Разбирает уже готовый license.lic для импорта в базу учёта — файлы,
 * выданные офлайн через Tools/New-LvaLicense.ps1 (сертификат «LVA Code
 * Signing», а не веб-ключ). Подпись здесь НЕ проверяется: публичного ключа
 * кода подписи (pubkey.cer) у веба нет и быть не должно — это отдельный,
 * офлайн контур. Импорт — учёт задним числом того, что админ и так уже
 * выпустил и передал, а не повторная выдача.
 */
export function parseLicenseFile(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Это не похоже на JSON — вставьте содержимое license.lic целиком.');
    }
    const p = parsed?.Payload;
    if (!p || typeof p !== 'object') throw new Error('В файле нет Payload — это не license.lic.');
    if (!parsed.Signature || typeof parsed.Signature !== 'string') {
        throw new Error('В файле нет Signature — это не license.lic.');
    }
    if (!Array.isArray(p.Products) || !p.Products.length) {
        throw new Error('Payload.Products пуст или это не список.');
    }
    if (!p.LicenseId || !p.IssuedUtc) {
        throw new Error('В Payload не хватает LicenseId или IssuedUtc.');
    }
    return parsed;
}

/**
 * Проверяет лицензию так же, как LicenseGate: подпись, срок, привязка, продукт.
 * Порядок вердиктов повторяет CheckInternal — чтобы причина отказа совпадала
 * с той, что увидит пользователь в плагине.
 */
export async function verifyLicenseFile(file, verifyKey, { product, machineId, now = new Date() } = {}) {
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
