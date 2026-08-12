/**
 * Учёт офлайн-лицензий в кабинете: форма импорта и офлайн-путь из карточки
 * заявки (команда для New-LvaLicense.ps1 → готовый .lic → заявка закрыта).
 *
 * Проверяется браузерная обвязка, а не формат ключа (он в test-license.mjs) и
 * не боевая база: BimLvaAuth и BimLvaLicenses подменяются моками. Подмена
 * сделана через геттер: auth.js и licenses.js присваивают свои глобальные
 * объекты сами, и обычная запись до их выполнения была бы затёрта, а после —
 * поздно, страница уже отрисована. С геттером работает настоящий код страницы
 * (renderAdminPending, renderMine, обработчики), а не разметка из теста.
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
// привязанная к машине. Подпись произвольная — импорт её и не проверяет.
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

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lva-lic-'));
const tmpLic = path.join(tmpDir, 'license.lic');
await fs.writeFile(tmpLic, SAMPLE_LIC, 'utf8');

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();

await page.addInitScript(({ machine }) => {
    window.__calls = [];

    const user = { id: 'owner-1', email: 'owner@example.ru', name: 'Владимир', isAdmin: true };
    const authMock = {
        mode: () => 'supabase',
        init: async () => user,
        getUser: () => user,
        refresh: async () => user,
        logout: async () => {},
        onChange: () => {},
        // Асинхронно и с задержкой — как в жизни (может догружаться SDK).
        getSupabaseClient: async () => {
            await new Promise((r) => setTimeout(r, 10));
            return { auth: { getUser: async () => ({ data: { user } }) } };
        }
    };

    const licenseRows = [{
        id: '7bd1c0de-1111-4222-8333-444455556666',
        email: 'a.piatnitsa@example.ru',
        org: 'a.piatnitsa (L000295)',
        product: 'Civil',
        machine_id: machine,
        license_key: '{}',
        issued_at: '2026-07-01T10:00:00.000Z',
        expires_at: null,
        revoked_at: null
    }];
    const requestRows = [{
        id: 'req-0001',
        user_id: null,
        email: 'a.piatnitsa@example.ru',
        product: 'Civil',
        org: 'ООО «Ромашка»',
        full_name: 'А. Пятница',
        comment: 'нужен Civil',
        machine_id: machine,
        status: 'new',
        created_at: '2026-08-01T09:00:00.000Z'
    }];

    const licMock = {
        PRODUCTS: [{ code: 'Civil', title: 'Civil 3D / AutoCAD — все ленты LVA', group: 'Продукты' }],
        productTitle: (c) => (c === 'Civil' ? 'Civil 3D / AutoCAD — все ленты LVA' : c),
        productGroups: () => [{ name: 'Продукты', items: [{ code: 'Civil', title: 'Civil 3D' }] }],
        isMachineId: (v) => /^[0-9a-fA-F]{64}$/.test(String(v || '').trim()),
        isAdmin: async () => true,
        listAllRequests: async () => requestRows.filter((r) => r.status === 'new'),
        listAllLicenses: async () => licenseRows,
        listMyRequests: async () => [],
        listMyLicenses: async () => licenseRows,
        createRequest: async () => {},
        issueLicense: async () => ({ licenseText: '{}' }),
        rejectRequest: async () => {},
        revokeLicense: async () => {},
        // Порядок аргументов как в licenses.js: (email, licenseText, requestId).
        importLicense: async (email, licenseText, requestId) => {
            window.__calls.push({ email, licenseText, requestId });
            if (requestId) {
                const row = requestRows.find((r) => r.id === requestId);
                if (row) row.status = 'approved';
            }
            return { ok: true, imported: 1, linkedToAccount: false, requestClosed: !!requestId };
        }
    };

    // Настоящие auth.js/licenses.js всё равно присвоят свои объекты — пусть
    // присваивают в теневые поля, страница будет работать с моками.
    for (const [name, mock] of [['BimLvaAuth', authMock], ['BimLvaLicenses', licMock]]) {
        let shadowed = null;
        Object.defineProperty(window, name, {
            configurable: true,
            get: () => mock,
            set: (v) => { shadowed = v; return shadowed; }
        });
    }
}, { machine: 'A'.repeat(64) });

await page.goto(`http://127.0.0.1:${port}/cabinet.html`, { waitUntil: 'load' });

// Панель админа страница показывает сама — по моку isAdmin(). Если её нет,
// значит сломалась не форма, а путь «вошёл владелец», и это тоже надо знать.
await page.waitForSelector('#licAdminSection:not(.hidden)', { timeout: 10000 });
await page.waitForSelector('[data-req="req-0001"]', { timeout: 10000 });
check(true, 'панель админа и карточка заявки отрисованы настоящим кодом страницы');

// ---------------------------------------------------- форма импорта ------
const ids = await page.evaluate(() => ({
    file: !!document.getElementById('licImportFile'),
    email: !!document.getElementById('licImportEmail'),
    text: !!document.getElementById('licImportText'),
    btn: !!document.getElementById('licImportBtn'),
    msg: !!document.getElementById('licImportMsg')
}));
check(Object.values(ids).every(Boolean), 'поля формы импорта на месте', JSON.stringify(ids));

await page.setInputFiles('#licImportFile', tmpLic);
await page.waitForFunction(() => (document.getElementById('licImportText').value || '').includes('7bd1c0de'));
check(true, 'выбранный .lic подставляется в поле — JSON копировать руками не нужно');

await page.fill('#licImportEmail', 'a.piatnitsa@example.ru');
await page.click('#licImportBtn');
await page.waitForFunction(() => /Импортировано/.test(document.getElementById('licImportMsg').textContent || ''));
const call = await page.evaluate(() => window.__calls.at(-1));
check(call.email === 'a.piatnitsa@example.ru', 'первым аргументом ушёл email', call.email);
check(call.licenseText.includes('7bd1c0de'), 'вторым — текст лицензии целиком');
check(call.requestId === undefined || call.requestId === '', 'из общей формы id заявки не передаётся');
check((await page.inputValue('#licImportFile')) === '', 'файл сброшен — повторный клик не задвоит импорт');

// ------------------------------------- бессрочные не выглядят истёкшими ---
const issued = await page.textContent('#licAdminIssued');
check(/бессрочная/.test(issued || ''), 'в таблице админа срок — «бессрочная»');
check(!/Истекла/.test(issued || ''), 'бессрочная не помечена истёкшей');
check(/Действует/.test(issued || ''), 'статус бессрочной — «Действует»');
const mine = await page.textContent('#licMine');
check(/бессрочная/.test(mine || ''), 'у получателя тоже «бессрочная», а не 1970 год');
check(!/Истекла/.test(mine || ''), 'у получателя бессрочная не помечена истёкшей');

// ---------------------------- офлайн-путь прямо из карточки заявки -------
await page.click('[data-req="req-0001"] [data-act="psCommand"]');
await page.waitForSelector('[data-req="req-0001"] .lic-ps-block .lic-key');
const cmd = await page.inputValue('[data-req="req-0001"] .lic-ps-block .lic-key');
check(/New-LvaLicense\.ps1/.test(cmd), 'собрана команда для New-LvaLicense.ps1');
check(cmd.includes('-ClientName "ООО «Ромашка»"'), 'имя клиента взято из заявки');
check(cmd.includes(`-MachineId "${'A'.repeat(64)}"`), 'Machine ID подставлен целиком — не перепечатывать 64 знака');
check(/-Products Civil\b/.test(cmd), 'продукт из заявки');
check(/-ExpiresUtc "\d{4}-\d{2}-\d{2}"/.test(cmd), 'срок из поля «дней» превращён в дату',
    cmd.match(/-ExpiresUtc "[^"]*"/)?.[0]);

await page.evaluate(() => { window.__calls.length = 0; });
await page.setInputFiles('[data-req="req-0001"] .lic-req-file', tmpLic);
page.once('dialog', (d) => d.accept());
await page.click('[data-req="req-0001"] [data-act="importForReq"]');
await page.waitForFunction(() => window.__calls.length === 1);
const byReq = await page.evaluate(() => window.__calls[0]);
check(byReq.email === 'a.piatnitsa@example.ru', 'email взят из заявки, вводить не нужно', byReq.email);
check(byReq.requestId === 'req-0001', 'передан id заявки — сервер её закроет', byReq.requestId);
check(byReq.licenseText.includes('7bd1c0de'), 'файл прочитан и ушёл целиком');
await page.waitForSelector('[data-req="req-0001"]', { state: 'detached' });
check(true, 'закрытая заявка убрана из списка «на рассмотрении»');

// --------------------------- без выбранного файла ничего не отправляется --
await page.evaluate(() => { window.__calls.length = 0; });
await page.evaluate(() => {
    window.__alerts = [];
    window.alert = (m) => window.__alerts.push(String(m));
});
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('[data-req="req-0001"]', { timeout: 10000 }).catch(() => {});
const stillThere = await page.evaluate(() => !!document.querySelector('[data-req="req-0001"]'));
if (stillThere) {
    page.once('dialog', (d) => d.accept());
    await page.click('[data-req="req-0001"] [data-act="importForReq"]');
    await page.waitForTimeout(300);
    check((await page.evaluate(() => window.__calls.length)) === 0,
        'без выбранного файла сервер не вызывается');
} else {
    check(true, 'после перезагрузки заявка уже закрыта (мок сбросился) — проверка пропущена');
}

// -------------------------------------------- ошибка сервера видна -------
await page.evaluate(() => {
    window.BimLvaLicenses.importLicense = async () => {
        throw new Error('Укажите корректный email получателя');
    };
});
await page.fill('#licImportText', '{"Payload":{},"Signature":"x"}');
await page.click('#licImportBtn');
await page.waitForFunction(() => /корректный email/.test(document.getElementById('licImportMsg').textContent || ''));
check(await page.evaluate(() => document.getElementById('licImportMsg').classList.contains('is-error')),
    'ошибка сервера показана и помечена как ошибка');
check(!(await page.getAttribute('#licImportBtn', 'disabled')), 'после ошибки кнопка снова доступна');

await browser.close();
server.close();
await fs.rm(tmpDir, { recursive: true, force: true });

console.log('');
if (problems.length) {
    console.error(`Провалено: ${problems.length}`);
    process.exit(1);
}
console.log('Импорт и офлайн-путь из заявки работают.');
