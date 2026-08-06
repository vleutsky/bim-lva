/**
 * Проверка формата лицензионного ключа: подпись, срок, подделка.
 *
 * Импортирует тот же license-format.js, что и Edge Function, поэтому проверяет
 * настоящий код выпуска, а не его пересказ. До живого Supabase дело не доходит —
 * здесь только криптография, и именно она должна быть безупречна: ошибку в ней
 * обнаружит клиент, которому ключ не подошёл.
 *
 * Запуск: npm run test-license
 */
import { generateKeyPairSync } from 'node:crypto';
import {
    importSigningKey,
    importVerifyKey,
    signLicense,
    verifyLicense,
    b64urlEncode
} from '../supabase/functions/license-issue/license-format.js';

let failures = 0;

function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const signKey = await importSigningKey(privB64);
const verKey = await importVerifyKey(pubB64);

const now = Math.floor(Date.now() / 1000);
const payload = {
    v: 1,
    id: 'a3f1c0de-0000-4000-8000-000000000001',
    p: 'ksi-mapper',
    e: 'engineer@example.org',
    o: 'ПроектСтройИнжиниринг',
    iss: 'BIM.LVA',
    iat: now,
    exp: now + 365 * 86400
};

// --- обычная жизнь ключа ---
const key = await signLicense(payload, signKey);
const good = await verifyLicense(key, verKey);
check('выданный ключ проходит проверку', good.ok, good.reason || '');
check('данные читаются обратно',
    good.payload?.e === payload.e && good.payload?.o === payload.o && good.payload?.p === payload.p);
check('ключ помещается в одно поле ввода', key.length < 400, `${key.length} символов`);
check('в ключе нет символов, ломающих копирование', /^[A-Za-z0-9._-]+$/.test(key));

// --- подделка ---
// Главное свойство схемы: имея ключ и публичный ключ, нельзя выписать себе
// другой. Проверяем самую наивную попытку — правку содержимого.
const forgedPayload = { ...payload, o: 'Другая организация', exp: now + 99 * 365 * 86400 };
const forgedBody = b64urlEncode(new TextEncoder().encode(JSON.stringify(forgedPayload)));
const forged = `BIMLVA1.${forgedBody}.${key.split('.')[2]}`;
const forgedResult = await verifyLicense(forged, verKey);
check('подменённое содержимое отвергается', !forgedResult.ok, forgedResult.reason);

const bitFlipped = key.slice(0, -2) + (key.endsWith('A') ? 'B' : 'A') + key.slice(-1);
const flippedResult = await verifyLicense(bitFlipped, verKey);
check('испорченная подпись отвергается', !flippedResult.ok, flippedResult.reason);

// Ключ, подписанный чужой парой, — попытка «сделаю свой генератор».
const other = generateKeyPairSync('ed25519');
const otherSignKey = await importSigningKey(
    other.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
);
const alienKey = await signLicense(payload, otherSignKey);
const alienResult = await verifyLicense(alienKey, verKey);
check('ключ от чужой пары отвергается', !alienResult.ok, alienResult.reason);

// --- сроки ---
const expired = await signLicense({ ...payload, iat: now - 400 * 86400, exp: now - 86400 }, signKey);
const expiredResult = await verifyLicense(expired, verKey);
check('просроченный ключ отвергается', !expiredResult.ok, expiredResult.reason);
check('просроченный ключ всё равно разобран', !!expiredResult.payload);

const future = await signLicense({ ...payload, iat: now + 30 * 86400, exp: now + 400 * 86400 }, signKey);
const futureResult = await verifyLicense(future, verKey);
check('ключ «из будущего» отвергается с понятной причиной',
    !futureResult.ok && /дат/i.test(futureResult.reason), futureResult.reason);

// --- мусор на входе ---
for (const [name, value] of [
    ['пустая строка', ''],
    ['произвольный текст', 'просто текст'],
    ['две части вместо трёх', 'BIMLVA1.abc'],
    ['чужой префикс', 'OTHER1.abc.def'],
    ['нечитаемый base64', 'BIMLVA1.!!!.???']
]) {
    const r = await verifyLicense(value, verKey);
    check(`отклоняет: ${name}`, !r.ok, r.reason);
}

// Пробелы по краям — обычное дело при копировании из письма.
const padded = await verifyLicense(`  ${key}\n`, verKey);
check('терпит пробелы вокруг скопированного ключа', padded.ok, padded.reason || '');

console.log('');
if (failures) {
    console.error(`Провалено проверок: ${failures}`);
    process.exit(1);
}
console.log('Формат лицензии в порядке: подпись держит, подделки и просрочка отсекаются.');
