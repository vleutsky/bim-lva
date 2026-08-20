/**
 * Правка и выгрузка IFC — то, что не было закрыто НИЧЕМ.
 *
 * Весь редактор (переименование, нормализация структуры, объединение файлов,
 * «Экспорт IFC») стоит на текстовом индексе: `indexIfcText` режет файл на
 * строки, `getEntityParts` достаёт сущность по номеру, `createIfcEditBatch`
 * переписывает строки и переиндексирует. Индекс сейчас переделывается ради
 * памяти, поэтому его механику надо зафиксировать ДО правок — иначе поломка
 * вылезет не здесь, а у пользователя в выгруженном файле.
 *
 * Проверяем не «не упало», а конкретные свойства:
 *   · имя сущности реально сменилось и читается обратно;
 *   · класс и число сущностей не изменились (переиндексация не потеряла файл);
 *   · выгруженный текст — валидный STEP: та же шапка, тот же счёт `#N=`,
 *     новое имя внутри, старого нет;
 *   · соседние сущности не задеты.
 *
 * Запуск: npm run test-ifc-edit
 */
import { chromium } from 'playwright';
import { makeGridIfc } from './fixtures/make-grid-ifc.mjs';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const check = (ok, what) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) problems.push(what);
};

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

const fixture = path.join(ROOT, 'tools', 'fixtures', 'edit-grid.ifc');
const source = makeGridIfc(40, 8, 4);
await fs.writeFile(fixture, source);

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.BimLvaDebug, null, { timeout: 60_000 });

    await page.setInputFiles('#localFileInput', fixture);
    await page.waitForFunction(
        () => (window.BimLvaDebug?.modelBounds || []).some((m) => /edit-grid\.ifc$/i.test(m.file)),
        null, { timeout: 120_000 }
    );
    await page.waitForTimeout(400);

    // Индекс ленивый: сразу после загрузки его быть НЕ должно, иначе экономия
    // памяти потеряна (а тест бы этого не заметил — правка всё равно работает).
    const lazy = await page.evaluate(() => window.BimLvaDebug.ifcIndexState('edit-grid'));
    check(lazy && lazy.canEdit, 'модель считается редактируемой сразу после загрузки');
    check(lazy && !lazy.built, 'текстовый индекс при загрузке НЕ построен (ленивый)');
    check(lazy && lazy.hasFile, 'ссылка на файл сохранена — есть откуда прочитать');

    // Берём реальный номер сущности из дерева, а не выдумываем
    const target = await page.evaluate(() => {
        const row = document.querySelector('#tree .trow[data-eid]');
        return row ? Number(row.dataset.eid) : null;
    });
    check(Number.isInteger(target), `нашлась сущность для правки (#${target})`);

    const NEW_NAME = 'Проверка правки IFC';
    const res = await page.evaluate(
        ([id, name]) => window.BimLvaDebug.ifcEditProbe('edit-grid', id, name),
        [target, NEW_NAME]
    );
    if (!res) {
        problems.push('ifcEditProbe вернул null — правка не выполнилась');
    } else {
        check(res.afterName === `'${NEW_NAME}'`,
            `имя сменилось и читается обратно (${res.beforeName} → ${res.afterName})`);
        check(res.afterClass === res.beforeClass,
            `класс не изменился (${res.beforeClass})`);
        check(res.edited, 'модель помечена изменённой (кнопка экспорта разблокируется)');

        // Выгруженный текст должен остаться валидным STEP
        const text = res.text;
        check(/^ISO-10303-21;/.test(text.trimStart()), 'выгрузка начинается с ISO-10303-21');
        check(/END-ISO-10303-21;\s*$/.test(text.trimEnd()), 'выгрузка кончается END-ISO-10303-21');
        check(text.includes('FILE_SCHEMA'), 'шапка FILE_SCHEMA на месте');
        check(text.includes(NEW_NAME), 'новое имя попало в выгруженный файл');

        // Счёт сущностей: сколько было в исходнике, столько и в выгрузке.
        // Ловит и потерю строк при splice, и задвоение при переиндексации.
        const countIn = (s) => (s.match(/^\s*#\d+\s*=/gm) || []).length;
        const srcCount = countIn(source);
        const outCount = countIn(text);
        check(outCount === srcCount,
            `сущностей в выгрузке ${outCount} = в исходнике ${srcCount}`);
        check(outCount === res.entities,
            `текст и индекс согласованы (${outCount} = ${res.entities})`);

        // Старое имя не должно остаться: правка заменяет, а не дописывает
        const oldName = String(res.beforeName || '').replace(/^'|'$/g, '');
        if (oldName && oldName !== '$') {
            check(!text.includes(oldName), `старое имя «${oldName}» убрано из файла`);
        }

        // Соседние сущности переиндексация трогать не должна
        const others = await page.evaluate(
            (id) => [...document.querySelectorAll('#tree .trow[data-eid]')]
                .map((r) => Number(r.dataset.eid)).filter((x) => x !== id).slice(0, 5),
            target
        );
        const intact = others.every((id) => text.includes(`#${id}=`));
        check(others.length > 0 && intact,
            `соседние сущности на месте (проверено ${others.length})`);
    }
    /* Удаление из сцены должно доходить до ФАЙЛА: раньше выгрузка отвечала
     * «Нет изменённых IFC-файлов», хотя из сцены всё убрано.
     * ⚠️ Проверять надо не флаг «изменено», а сам текст: флаг легко поставить,
     * а вычеркнуть сущности и почистить связи — совсем другая работа. */
    const del = await page.evaluate(async () => {
        const D = window.BimLvaDebug;
        const mod = D.modelBounds.find((m) => /edit-grid/i.test(m.file));
        if (!mod) return null;
        // Берём пару настоящих идентификаторов стен из текста файла.
        const probe = await D.ifcDeleteProbe('edit-grid', []);
        const ids = [...(probe.text.matchAll(/#(\d+)=IFCWALL\(/gi))].slice(0, 2)
            .map((m) => parseInt(m[1], 10));
        if (ids.length < 2) return { ids: [] };
        const after = await D.ifcDeleteProbe('edit-grid', ids);
        return { ids, edited: after.edited, text: after.text };
    });
    if (!del || !del.ids.length) {
        check(false, 'удаление: не нашлось стен для проверки');
    } else {
        const gone = del.ids.every((id) => !new RegExp(`#${id}=IFCWALL\\(`, 'i').test(del.text));
        const dangling = del.ids.some((id) => new RegExp(`\\(#${id}[,)]|,#${id}[,)]`).test(del.text));
        console.log(`  удаление: вычеркнуты #${del.ids.join(', #')}`);
        check(del.edited, 'модель помечена изменённой после удаления из сцены');
        check(gone, `удалённые сущности вычеркнуты из текста (#${del.ids.join(', #')})`);
        check(!dangling, 'висячих ссылок на удалённое в связях не осталось');
    }

} catch (error) {
    problems.push('исключение: ' + (error?.message || error));
} finally {
    await browser.close();
    server.close();
    await fs.rm(fixture, { force: true });
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — правка и выгрузка IFC не ломают файл.');
