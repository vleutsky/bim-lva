/**
 * Формат лицензионного ключа BIM.LVA — общий код для выпуска и проверки.
 *
 * Лежит отдельным файлом, потому что его импортируют двое: Edge Function,
 * которая ключи подписывает, и тест, который проверяет подпись. Если бы формат
 * был написан в каждом месте заново, они разошлись бы молча — и обнаружилось
 * бы это на первом же клиенте, которому ключ не подошёл.
 *
 * Обычный .js, а не .ts: так его берут и Deno, и Node без сборки.
 *
 *   BIMLVA1.<payload base64url>.<подпись base64url>
 *
 * Подпись считается по байтам строки "BIMLVA1.<payload>" — плагин проверяет
 * ровно то, что видит, не пересобирая JSON и не гадая о порядке полей.
 */

export const PREFIX = 'BIMLVA1';

export function b64urlEncode(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text) {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** @param {string} b64 приватный ключ, base64 от PKCS#8 */
export async function importSigningKey(b64) {
    return crypto.subtle.importKey('pkcs8', b64urlDecode(b64), { name: 'Ed25519' }, false, ['sign']);
}

/** @param {string} b64 публичный ключ, base64 от SPKI */
export async function importVerifyKey(b64) {
    return crypto.subtle.importKey('spki', b64urlDecode(b64), { name: 'Ed25519' }, false, ['verify']);
}

/** Собирает и подписывает ключ. */
export async function signLicense(payload, signingKey) {
    const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const signed = `${PREFIX}.${body}`;
    const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, signingKey, new TextEncoder().encode(signed))
    );
    return `${signed}.${b64urlEncode(sig)}`;
}

/**
 * Проверяет ключ публичным ключом. Возвращает разбор и причину отказа.
 * Срок действия проверяется здесь же: подпись верна и у просроченного ключа.
 */
export async function verifyLicense(key, verifyKey, now = new Date()) {
    const parts = String(key || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) {
        return { ok: false, reason: 'не похоже на ключ BIM.LVA' };
    }
    const [, body, sig] = parts;

    let valid = false;
    try {
        valid = await crypto.subtle.verify(
            { name: 'Ed25519' },
            verifyKey,
            b64urlDecode(sig),
            new TextEncoder().encode(`${PREFIX}.${body}`)
        );
    } catch {
        return { ok: false, reason: 'подпись повреждена' };
    }
    if (!valid) return { ok: false, reason: 'подпись не совпала — ключ подделан или испорчен' };

    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    } catch {
        return { ok: false, reason: 'содержимое ключа нечитаемо' };
    }

    const seconds = Math.floor(now.getTime() / 1000);
    if (payload.exp && seconds > payload.exp) {
        return { ok: false, reason: 'срок действия истёк', payload };
    }
    if (payload.iat && seconds + 86400 < payload.iat) {
        // Час назад выданный ключ «из будущего» — обычно сбитые часы на машине.
        return { ok: false, reason: 'ключ ещё не действует — проверьте дату на компьютере', payload };
    }
    return { ok: true, payload };
}
