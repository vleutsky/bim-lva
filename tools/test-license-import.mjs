/**
 * Импорт офлайн-лицензий в кабинете: выбор файла, вызов сервера, показ ошибок и
 * бессрочные лицензии в списке.
 *
 * Проверяется браузерная обвязка, а не формат (формат — в test-license.mjs) и не
 * боевая база: BimLvaLicenses подменяется моком, поэтому ни Supabase, ни
 * Edge Function здесь не участвуют.
 *
 * Отдельно проверяется бессрочная лицензия: `expires_at = null` проходил через
 * `new Date(null)` и показывался как «Истекла» 1970 годом. Офлайн-скрипт без
 * -ExpiresUtc выдаёт именно такие, так что после импорта это видно сразу.
 *
 * Запуск: node tools/test-license-import.mjs
 */
import { chromium } from 'playwright';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function check(ok, label, extra = '') {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
    if (!ok) problems.push(label + (extra ? ' — ' + extra : ''));
}

async function resolveChromium() {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!base) return undefined;
    const entries = await fs.readdir(base).catch(() => []);
    for (const dir of entries.filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        const bin = path.join(base, dir, 'chrome-linux', 'chrome');
        if (await fs.access(bin).then(() => true, () => false)) return bin;
    }
    return undefined;
}

// Лицензия того же вида, что выдаёт Tools\New-LvaLicense.ps1: бессрочная,
// привязанная к машине. Подпись произвольная — её проверяет плагин у клиента,
// а импорт по замыслу подпись не перепроверяет.
const SAMPLE_LIC = JSON.stringify({
    Payload: {
        LicenseId: '7bd1c0de-1111-4222-8333-444455556666',
        ClientName: 'a.piatnitsa (L000295)',
        Products: ['Civil'],
        IssuedUtc: '2026-07-01T10:00:00.0000000Z',
        ExpiresUtc: null,
        HostLock: 'A'.repeat(64)
    },
    Signature: 'ZmFrZS1zaWduYXR1cmU='
}, null, 2);

const tmpLic = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lva-lic-')), 'license.lic');
await fs.writeFile(tmpLic, SAMPLE_LIC, 'utf8');

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();

await page.goto(`http://127.0.0.1:${port}/cabinet.html`, { waitUntil: 'load' });

// Мок ставим после загрузки: licenses.js присваивает window.BimLvaLicenses сам,
// и подстановка через addInitScript была бы затёрта.
await page.evaluate(() => {
    window.__calls = [];
    const rows = [{
        id: '7bd1c0de-1111-4222-8333-444455556666',
        email: 'a.piatnitsa@example.ru',
        org: 'a.piatnitsa (L000295)',
        product: 'Civil',
        machine_id: 'A'.repeat(64),
        issued_at: '2026-07-01T10:00:00.000Z',
        expires_at: null,
        revoked_at: null
    }];
    window.BimLvaLicenses = {
        productTitle: (c) => (c === 'Civil' ? 'Civil 3D / AutoCAD — все ленты LVA' : c),
        productGroups: () => [],
        isAdmin: async () => true,
        listAllRequests: async () => [],
        listAllLicenses: async () => rows,
        listMyRequests: async () => [],
        listMyLicenses: async () => rows,
        // Порядок аргументов как в licenses.js: (email, licenseText).
        importLicense: async (email, licenseText) => {
            window.__calls.push({ email, licenseText });
            return { ok: true, imported: 1, linkedToAccount: false };
        }
    };
});

// Гейт входа и признак админа здесь не проверяются (для этого есть настоящая
// сессия и таблица license_admins) — приводим интерфейс в состояние «вошёл
// владелец», чтобы дотянуться до формы. На права это не влияет: их проверяет
// Edge Function на сервере.
await page.evaluate(() => {
    document.getElementById('cabGate')?.classList.add('hidden');
    document.getElementById('cabMain')?.classList.remove('hidden');
    document.getElementById('licAdminSection')?.classList.remove('hidden');
});

// ---------------------------------------------------- разметка на месте ----
const ids = await page.evaluate(() => ({
    file: !!document.getElementById('licImportFile'),
    email: !!document.getElementById('licImportEmail'),
    text: !!document.getElementById('licImportText'),
    btn: !!document.getElementById('licImportBtn'),
    msg: !!document.getElementById('licImportMsg')
}));
check(Object.values(ids).every(Boolean), 'все поля формы импорта есть в разметке', JSON.stringify(ids));

// ------------------------------------------- файл читается в поле текста ----
await page.setInputFiles('#licImportFile', tmpLic);
await page.waitForFunction(() => (document.getElementById('licImportText').value || '').includes('7bd1c0de'));
check(true, 'выбранный .lic подставляется в поле — JSON копировать руками не нужно');
const afterFile = await page.textContent('#licImportMsg');
check(/Файл прочитан/.test(afterFile || ''), 'видно, какой файл взят', afterFile);

// -------------------------------------------------- обычный путь импорта ----
await page.fill('#licImportEmail', 'a.piatnitsa@example.ru');
await page.click('#licImportBtn');
await page.waitForFunction(() => /Импортировано/.test(document.getElementById('licImportMsg').textContent || ''));

const calls = await page.evaluate(() => window.__calls);
check(calls.length === 1, 'сервер вызван один раз', String(calls.length));
check(calls[0]?.email === 'a.piatnitsa@example.ru', 'первым аргументом ушёл email', calls[0]?.email);
check(calls[0]?.licenseText?.includes('7bd1c0de'), 'вторым — текст лицензии целиком');

const msg = await page.textContent('#licImportMsg');
check(/Импортировано/.test(msg || ''), 'показан результат импорта', msg);
check((await page.inputValue('#licImportText')) === '', 'поле текста очищено после успеха');
check((await page.inputValue('#licImportFile')) === '', 'выбранный файл сброшен — повторный клик не задвоит импорт');

// ------------------------------------- бессрочная не выглядит истёкшей ----
const issued = await page.textContent('#licAdminIssued');
check(/бессрочная/.test(issued || ''), 'в таблице админа срок указан как «бессрочная»');
check(!/Истекла/.test(issued || ''), 'бессрочная не показана истёкшей');
check(/Действует/.test(issued || ''), 'статус бессрочной — «Действует»');

// Список получателя («Мои заявки и ключи») рисуется на старте, до подмены мока,
// поэтому проверяем не его вывод, а сам код: нигде не должно остаться сравнения
// даты без защиты от null — иначе бессрочная снова станет «Истекла» 1970 года.
// Так же ловится и регресс, если кто-то поправит только одно из двух мест.
const source = await fs.readFile(path.join(ROOT, 'cabinet.html'), 'utf8');
const dateCompares = source.match(/new Date\(l\.expires_at\)\s*</g) ?? [];
const guarded = source.match(/l\.expires_at && new Date\(l\.expires_at\)\s*</g) ?? [];
check(dateCompares.length > 0 && dateCompares.length === guarded.length,
    'все сравнения срока защищены от null (бессрочные не «Истекла»)',
    `сравнений ${dateCompares.length}, с защитой ${guarded.length}`);
const dateShows = source.match(/asDate\(l\.expires_at\)/g) ?? [];
const guardedShows = source.match(/l\.expires_at \? [^\n]*asDate\(l\.expires_at\)/g) ?? [];
check(dateShows.length === guardedShows.length,
    'вывод срока тоже с проверкой на null',
    `выводов ${dateShows.length}, с проверкой ${guardedShows.length}`);

// -------------------------------------------- ошибка сервера видна -------
await page.evaluate(() => {
    window.BimLvaLicenses.importLicense = async () => {
        throw new Error('Укажите корректный email получателя');
    };
});
await page.fill('#licImportText', SAMPLE_LIC);
await page.click('#licImportBtn');
await page.waitForFunction(() => /корректный email/.test(document.getElementById('licImportMsg').textContent || ''));
check(true, 'ошибка сервера показана пользователю текстом');
check(await page.evaluate(() => document.getElementById('licImportMsg').classList.contains('is-error')),
    'сообщение об ошибке помечено как ошибка');
check(!(await page.getAttribute('#licImportBtn', 'disabled')), 'после ошибки кнопка снова доступна');

await browser.close();
server.close();
await fs.rm(path.dirname(tmpLic), { recursive: true, force: true });

console.log('');
if (problems.length) {
    console.error(`Провалено: ${problems.length}`);
    process.exit(1);
}
console.log('Импорт в кабинете работает: файл, вызов, ошибки, бессрочные лицензии.');
