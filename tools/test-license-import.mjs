/**
 * Учёт выданных офлайн лицензий: форма «Учесть выданный ключ (.lic)» в кабинете.
 *
 * Проверяется браузерная обвязка, а не формат (формат — в test-license.mjs) и не
 * боевая база: BimLvaAuth и BimLvaLicenses подменяются моками. Мок
 * getSupabaseClient() намеренно асинхронный — на синхронной обёртке вокруг него
 * уже обжигались (см. CLAUDE.md), и подмена воспроизводит те же условия.
 *
 * Отдельно проверяется бессрочная лицензия: expires_at = null раньше проходил
 * через new Date(null) и показывался как «Истекла» 1970 годом.
 *
 * Запуск: node tools/test-license-import.mjs
 */
import { chromium } from 'playwright';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
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
// привязанная к машине. Подпись здесь произвольная — её проверяет плагин.
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

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();

await page.goto(`http://127.0.0.1:${port}/cabinet.html`, { waitUntil: 'load' });

// Подменяем клиент лицензий уже после загрузки: и auth.js, и licenses.js
// присваивают свои глобальные объекты сами, поэтому подстановка через
// addInitScript была бы затёрта.
await page.evaluate(() => {
    window.__calls = [];
    const rows = [
        {
            id: '7bd1c0de-1111-4222-8333-444455556666',
            email: 'a.piatnitsa@example.ru',
            org: 'a.piatnitsa (L000295)',
            product: 'Civil',
            machine_id: 'A'.repeat(64),
            issued_at: '2026-07-01T10:00:00.000Z',
            expires_at: null,
            revoked_at: null
        }
    ];
    window.BimLvaLicenses = {
        productTitle: (c) => (c === 'Civil' ? 'Civil 3D / AutoCAD — все ленты LVA' : c),
        productGroups: () => [],
        isAdmin: async () => true,
        listAllRequests: async () => [],
        listAllLicenses: async () => rows,
        listMyRequests: async () => [],
        listMyLicenses: async () => [],
        importLicense: async (licenseText, email) => {
            window.__calls.push({ licenseText, email });
            return {
                ok: true,
                licenseId: '7bd1c0de-1111-4222-8333-444455556666',
                product: 'Civil',
                clientName: 'a.piatnitsa (L000295)',
                machineId: 'A'.repeat(64),
                linkedToAccount: false,
                expiresAt: null
            };
        }
    };
});

// Гейт входа и признак админа здесь не проверяются (для этого есть настоящая
// сессия и таблица license_admins) — приводим интерфейс в состояние «вошёл
// владелец», чтобы дотянуться до самой формы. На права это не влияет: их всё
// равно проверяет Edge Function на сервере.
await page.evaluate(() => {
    document.getElementById('cabGate')?.classList.add('hidden');
    document.getElementById('cabMain')?.classList.remove('hidden');
    document.getElementById('licAdminSection')?.classList.remove('hidden');
});

// ---------------------------------------------------- разметка на месте ----
const ids = await page.evaluate(() => ({
    file: !!document.getElementById('licImportFile'),
    email: !!document.getElementById('licImportEmail'),
    btn: !!document.getElementById('licImportBtn'),
    text: !!document.getElementById('licImportText'),
    status: !!document.getElementById('licImportStatus')
}));
check(Object.values(ids).every(Boolean), 'все поля формы импорта есть в разметке', JSON.stringify(ids));

// -------------------------------------------- пустой ввод не улетает ------
await page.evaluate(() => document.getElementById('licImportBtn').click());
let status = await page.textContent('#licImportStatus');
check(/Выберите файл/i.test(status || ''), 'пустой ввод не отправляется на сервер', status);
check((await page.evaluate(() => window.__calls.length)) === 0, 'при пустом вводе сервер не вызывается');

// ------------------------------------------------- обычный путь импорта ----
await page.fill('#licImportText', SAMPLE_LIC);
await page.fill('#licImportEmail', 'a.piatnitsa@example.ru');
await page.evaluate(() => document.getElementById('licImportBtn').click());
await page.waitForFunction(() => /Учтено|не/i.test(document.getElementById('licImportStatus').textContent || ''));

const calls = await page.evaluate(() => window.__calls);
check(calls.length === 1, 'сервер вызван один раз', String(calls.length));
check(calls[0]?.licenseText?.includes('7bd1c0de'), 'на сервер ушёл текст лицензии целиком');
check(calls[0]?.email === 'a.piatnitsa@example.ru', 'почта получателя передана', calls[0]?.email);

status = await page.textContent('#licImportStatus');
check(/Учтено/.test(status || ''), 'показан результат учёта', status);
check(/без аккаунта/.test(status || ''), 'сказано, что аккаунта у получателя нет', status);
check((await page.inputValue('#licImportText')) === '', 'поле очищено после успеха');

// ------------------------------------- бессрочная не выглядит истёкшей ----
const issued = await page.textContent('#licAdminIssued');
check(/бессрочная/.test(issued || ''), 'бессрочная лицензия подписана как бессрочная', (issued || '').slice(0, 120));
check(!/Истекла/.test(issued || ''), 'бессрочная не показана истёкшей');
check(/Действует/.test(issued || ''), 'статус бессрочной — «Действует»');

// ------------------------------------------- ошибка сервера видна -------
await page.evaluate(() => {
    window.BimLvaLicenses.importLicense = async () => {
        throw new Error('Эта лицензия уже учтена.');
    };
});
await page.fill('#licImportText', SAMPLE_LIC);
await page.evaluate(() => document.getElementById('licImportBtn').click());
await page.waitForFunction(() => /уже учтена/.test(document.getElementById('licImportStatus').textContent || ''));
status = await page.textContent('#licImportStatus');
check(/уже учтена/.test(status || ''), 'ошибка сервера показана пользователем текстом', status);
check(!(await page.getAttribute('#licImportBtn', 'disabled')), 'после ошибки кнопка снова доступна');

await browser.close();
server.close();

console.log('');
if (problems.length) {
    console.error(`Провалено: ${problems.length}`);
    process.exit(1);
}
console.log('Форма учёта офлайн-лицензий работает: ввод, вызов, ошибки, бессрочные.');
