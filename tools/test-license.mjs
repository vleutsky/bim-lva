/**
 * Проверка формата лицензии LVA BIM — того, что уже понимают плагины.
 *
 * Импортирует тот же license-lic.js, что и Edge Function, поэтому проверяет
 * настоящий код выпуска. Компилятора .NET здесь нет, поэтому совместимость
 * доказывается иначе: воспроизводится логика LicensePayload.ToCanonicalString()
 * и LicenseGate.VerifySignature, и результаты сверяются побайтно.
 *
 * Главная опасность этой связки — не криптография, а формат: C# читает JSON в
 * DateTime и собирает каноническую строку заново. Если наша строка отличается
 * от восстановленной хоть одним знаком, подпись не сойдётся — и узнает об этом
 * клиент, а не мы. Поэтому половина проверок ниже про даты и порядок полей.
 *
 * Запуск: npm run test-license
 */
import { generateKeyPairSync, createVerify, createSign } from 'node:crypto';
import fs from 'node:fs/promises';
import {
    canonicalString,
    toDotNetRoundTrip,
    importRsaSigningKey,
    importRsaVerifyKey,
    signLicenseFile,
    verifyLicenseFile,
    isMachineId,
    parseLicenseFile
} from '../supabase/functions/license-issue/license-lic.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const signKey = await importRsaSigningKey(privB64);
const verKey = await importRsaVerifyKey(pubB64);

// ---------------------------------------------------------------- даты ----
// .NET ToString("o") для UTC даёт ровно семь знаков дробной части и «Z».
const d = new Date(Date.UTC(2026, 7, 6, 12, 34, 56, 789));
check('дата в формате .NET "o"', toDotNetRoundTrip(d) === '2026-08-06T12:34:56.7890000Z',
    toDotNetRoundTrip(d));
check('семь знаков дробной части, не три',
    /\.\d{7}Z$/.test(toDotNetRoundTrip(d)));
check('полночь тоже с дробной частью',
    toDotNetRoundTrip(new Date(Date.UTC(2027, 0, 1))) === '2027-01-01T00:00:00.0000000Z');

// ------------------------------------------------- каноническая строка ----
// Копия LicensePayload.ToCanonicalString() — если разойдётся, подпись не сойдётся.
function csharpCanonical(p) {
    const products = p.Products == null ? '' : p.Products.join(',');
    const expires = p.ExpiresUtc ? p.ExpiresUtc : '';
    return [p.LicenseId, p.ClientName ?? '', products, p.IssuedUtc, expires, p.HostLock ?? ''].join('|');
}

const samplePayload = {
    LicenseId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    ClientName: 'ООО «Ромашка»',
    Products: ['Civil', 'Navis'],
    IssuedUtc: '2026-08-06T12:34:56.7890000Z',
    ExpiresUtc: '2027-08-06T00:00:00.0000000Z',
    HostLock: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90'
};
check('каноническая строка совпадает с логикой C#',
    canonicalString(samplePayload) === csharpCanonical(samplePayload));
check('поля разделены «|», продукты — «,»',
    canonicalString(samplePayload).split('|').length === 6 &&
    canonicalString(samplePayload).split('|')[2] === 'Civil,Navis');
check('у бессрочной лицензии в строке пусто, а не «null»',
    canonicalString({ ...samplePayload, ExpiresUtc: null }).split('|')[4] === '');

// ---------------------------------------------------------- подпись -------
const lic = await signLicenseFile({
    licenseId: samplePayload.LicenseId,
    clientName: samplePayload.ClientName,
    products: ['Civil', 'Navis'],
    issuedUtc: d,
    expiresUtc: new Date(Date.UTC(2027, 7, 6)),
    hostLock: samplePayload.HostLock
}, signKey);

const good = await verifyLicenseFile(lic, verKey, { product: 'Civil', machineId: samplePayload.HostLock });
check('выданная лицензия проходит проверку', good.ok, good.status);

// Главное: подпись должна приниматься тем же вызовом, что делает .NET —
// RSA.VerifyData(data, sig, SHA256, Pkcs1). В Node это RSA-SHA256 без опций.
const nodeVerify = createVerify('RSA-SHA256');
nodeVerify.update(Buffer.from(canonicalString(lic.Payload), 'utf8'));
check('подпись проходит проверку алгоритмом RSA-SHA256/PKCS#1 (как в .NET)',
    nodeVerify.verify(publicKey, Buffer.from(lic.Signature, 'base64')));

// И наоборот: подпись, сделанная «как в PowerShell», принимается нашей проверкой.
const psSign = createSign('RSA-SHA256');
psSign.update(Buffer.from(canonicalString(lic.Payload), 'utf8'));
const psSignature = psSign.sign(privateKey).toString('base64');
check('подпись из PowerShell-совместимого вызова принимается',
    (await verifyLicenseFile({ ...lic, Signature: psSignature }, verKey, { product: 'Civil' })).ok);

// ------------------------------------------- имитация обратного разбора ----
// C# читает JSON в DateTime и собирает строку заново. Прогоняем тот же круг:
// JSON → разбор → повторная сборка строки → проверка подписи.
const roundTripped = JSON.parse(JSON.stringify(lic));
roundTripped.Payload.IssuedUtc = toDotNetRoundTrip(new Date(roundTripped.Payload.IssuedUtc));
roundTripped.Payload.ExpiresUtc = roundTripped.Payload.ExpiresUtc
    ? toDotNetRoundTrip(new Date(roundTripped.Payload.ExpiresUtc))
    : null;
check('после разбора и повторной сборки строка та же',
    canonicalString(roundTripped.Payload) === canonicalString(lic.Payload));
check('после круга через JSON подпись всё ещё верна',
    (await verifyLicenseFile(roundTripped, verKey, { product: 'Civil' })).ok);

// ------------------------------------------------------------ отказы ------
const tampered = JSON.parse(JSON.stringify(lic));
tampered.Payload.Products = ['*'];
check('подмена продуктов на «*» отвергается',
    !(await verifyLicenseFile(tampered, verKey, { product: 'Civil' })).ok);

const stretched = JSON.parse(JSON.stringify(lic));
stretched.Payload.ExpiresUtc = '2099-01-01T00:00:00.0000000Z';
check('продление срока правкой файла отвергается',
    !(await verifyLicenseFile(stretched, verKey, { product: 'Civil' })).ok);

const alien = generateKeyPairSync('rsa', { modulusLength: 2048 });
const alienKey = await importRsaSigningKey(alien.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
const alienLic = await signLicenseFile({
    licenseId: samplePayload.LicenseId, clientName: 'Кто-то', products: ['*'],
    issuedUtc: d, expiresUtc: null, hostLock: ''
}, alienKey);
check('лицензия от чужой пары ключей отвергается',
    !(await verifyLicenseFile(alienLic, verKey, { product: 'Civil' })).ok);

const expired = await signLicenseFile({
    licenseId: samplePayload.LicenseId, clientName: 'Просрочка', products: ['Civil'],
    issuedUtc: new Date(Date.UTC(2020, 0, 1)), expiresUtc: new Date(Date.UTC(2021, 0, 1)), hostLock: ''
}, signKey);
check('просроченная лицензия отвергается',
    (await verifyLicenseFile(expired, verKey, { product: 'Civil' })).status === 'Expired');

check('лицензия для другой машины отвергается',
    (await verifyLicenseFile(lic, verKey, { product: 'Civil', machineId: 'B'.repeat(64) })).status === 'WrongMachine');
check('лицензия на другой продукт отвергается',
    (await verifyLicenseFile(lic, verKey, { product: 'Inventor' })).status === 'WrongProduct');

const wildcard = await signLicenseFile({
    licenseId: samplePayload.LicenseId, clientName: 'Всё', products: ['*'],
    issuedUtc: d, expiresUtc: null, hostLock: ''
}, signKey);
check('«*» открывает любой продукт',
    (await verifyLicenseFile(wildcard, verKey, { product: 'Inventor' })).ok);
check('бессрочная лицензия не считается просроченной',
    (await verifyLicenseFile(wildcard, verKey, { product: 'Civil' })).ok);

// -------------------------------------------------------- Machine ID ------
check('Machine ID распознаётся', isMachineId('A1B2C3D4E5F60718293A4B5C6D7E8F90'.repeat(2)));
check('короткий Machine ID отклоняется', !isMachineId('ABC123'));
check('Machine ID с посторонними знаками отклоняется', !isMachineId('Z'.repeat(64)));
check('HostLock приводится к верхнему регистру',
    (await signLicenseFile({
        licenseId: samplePayload.LicenseId, clientName: 'x', products: ['Civil'],
        issuedUtc: d, expiresUtc: null, hostLock: '  a1b2c3'.padEnd(64, 'f').trim()
    }, signKey)).Payload.HostLock.match(/^[0-9A-F]+$/) !== null);

// --------------------------------------- импорт офлайн-лицензий -----------
// parseLicenseFile проверяет только форму (для импорта уже подписанных
// файлов в базу учёта) — не подпись: публичного ключа кода подписи у веба
// нет и не должно быть, это отдельный офлайн-контур.
{
    const offlineLic = await signLicenseFile({
        licenseId: samplePayload.LicenseId, clientName: 'a.piatnitsa (L000295)',
        products: ['Civil'], issuedUtc: d, expiresUtc: null, hostLock: samplePayload.HostLock
    }, signKey); // ключ здесь любой — parseLicenseFile подпись не проверяет

    const parsed = parseLicenseFile(JSON.stringify(offlineLic));
    check('parseLicenseFile разбирает валидный license.lic',
        parsed.Payload.LicenseId === samplePayload.LicenseId);

    check('parseLicenseFile отвергает не-JSON',
        (() => { try { parseLicenseFile('это не json'); return false; } catch { return true; } })());
    check('parseLicenseFile отвергает файл без Payload',
        (() => { try { parseLicenseFile(JSON.stringify({ Signature: 'x' })); return false; } catch { return true; } })());
    check('parseLicenseFile отвергает файл без Signature',
        (() => { try { parseLicenseFile(JSON.stringify({ Payload: offlineLic.Payload })); return false; } catch { return true; } })());
    check('parseLicenseFile отвергает пустой список продуктов',
        (() => {
            try { parseLicenseFile(JSON.stringify({ ...offlineLic, Payload: { ...offlineLic.Payload, Products: [] } })); return false; }
            catch { return true; }
        })());
}

// ------------------------------------------ однофайловая сборка ----------
// Её собирает механический скрипт для развёртывания через дашборд. Разойдётся
// с исходником — лицензии из неё перестанут проходить проверку в плагинах.
const bundled = await fs.readFile(
    new URL('../supabase/functions/license-issue/bundled.ts', import.meta.url), 'utf8'
);
const START = '// ---- начало вклеенного license-lic.js ----';
const END = '// ---- конец вклеенного license-lic.js ----';
if (!bundled.includes(START) || !bundled.includes(END)) {
    check('в bundled.ts есть вклеенный модуль формата', false);
} else {
    const inner = bundled.slice(bundled.indexOf(START) + START.length, bundled.indexOf(END));
    const tmp = new URL('./_bundled-lic.check.mjs', import.meta.url);
    await fs.writeFile(tmp,
        inner + '\nexport { signLicenseFile, canonicalString, importRsaSigningKey, toDotNetRoundTrip };\n');
    try {
        const mod = await import(tmp.href);
        const bKey = await mod.importRsaSigningKey(privB64);
        const fromBundle = await mod.signLicenseFile({
            licenseId: samplePayload.LicenseId, clientName: samplePayload.ClientName,
            products: ['Civil', 'Navis'], issuedUtc: d,
            expiresUtc: new Date(Date.UTC(2027, 7, 6)), hostLock: samplePayload.HostLock
        }, bKey);
        check('сборка выдаёт ту же лицензию байт в байт',
            JSON.stringify(fromBundle) === JSON.stringify(lic));
        check('лицензия из сборки проходит проверку исходным модулем',
            (await verifyLicenseFile(fromBundle, verKey, { product: 'Civil' })).ok);
    } finally {
        await fs.rm(tmp, { force: true });
    }
}

console.log('');
if (failures) {
    console.error(`Провалено проверок: ${failures}`);
    process.exit(1);
}
console.log('Формат совпадает с тем, что проверяет LicenseGate в плагинах.');
