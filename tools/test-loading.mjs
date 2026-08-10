/**
 * Загрузка и работа со сценой: пресеты классов, удаление элементов, точка
 * вставки по координатам, пачка файлов (общий прогресс, список с отметками,
 * отсутствие мигания), совместимость IFC4X1, журнал уведомлений.
 *
 * Запуск: npm run test-loading
 */
import { chromium } from 'playwright';
import { makeGridIfc } from './fixtures/make-grid-ifc.mjs';
import { makeBlocksDxf } from './fixtures/make-blocks-dxf.mjs';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

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

async function resetInput(page) {
    await page.evaluate(() => { document.getElementById('localFileInput').value = ''; });
}

async function waitModels(page, n, timeout = 90_000) {
    await page.waitForFunction(
        (want) => window.BimLvaDebug?.modelCount === want && (want === 0 || (window.BimLvaDebug?.modelBounds || []).length >= 1),
        n,
        { timeout }
    );
    // Кнопки включаются в самом конце loadFilesSequentially — не кликать раньше
    if (n > 0) {
        await page.waitForFunction(
            () => !document.getElementById('clear').disabled &&
                !document.getElementById('loader').classList.contains('show'),
            { timeout: 30_000 }
        );
    }
}

async function clearModels(page) {
    const has = await page.evaluate(() => window.BimLvaDebug?.modelCount > 0);
    if (has) {
        // Кнопка включается в самом конце загрузки: клик раньше молча пропадёт
        await page.waitForFunction(
            () => !document.getElementById('clear').disabled &&
                !document.getElementById('loader').classList.contains('show'),
            { timeout: 60_000 }
        );
        await page.evaluate(() => document.getElementById('clear').click());
        await page.waitForFunction(() => window.BimLvaDebug?.modelCount === 0, { timeout: 30_000 });
    }
    await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));
}

async function setPreset(page, id) {
    await page.evaluate((presetId) => {
        const sel = document.getElementById('loadPresetSelect');
        sel.value = presetId;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, id);
}

async function main() {
    const { server, port } = await startStaticServer(ROOT);
    const browser = await chromium.launch({ executablePath: await resolveChromium() });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept());
    page.on('pageerror', (e) => { problems.push('pageerror: ' + e.message); console.error('pageerror:', e.message); });
    page.on('console', (m) => { if (m.type() === 'error') console.error('console.error:', m.text().slice(0, 300)); });

    const gridPath = path.join(ROOT, 'tools', 'fixtures', 'feature-grid.ifc');
    const dxfPath = path.join(ROOT, 'tools', 'fixtures', 'feature-blocks.dxf');
    await fs.writeFile(gridPath, makeGridIfc());
    await fs.writeFile(dxfPath, makeBlocksDxf().text);

    try {
        await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'load' });
        await page.waitForTimeout(1500);

        // Селектор пресетов существует и заполнен
        const presetCount = await page.evaluate(() => document.getElementById('loadPresetSelect')?.options.length || 0);
        if (presetCount < 4) problems.push(`селектор пресетов: ${presetCount} опций, ожидалось ≥4`);

        // A. Пресет «каркас»: стены фикстуры должны загрузиться
        await setPreset(page, 'structure');
        await page.setInputFiles('#localFileInput', gridPath);
        await waitModels(page, 1);
        const meshesA = await page.evaluate(() => window.BimLvaDebug.meshCount);
        if (!(meshesA > 0)) problems.push('пресет «каркас»: стены не загрузились');
        console.log(`A. пресет «каркас»: модель загружена, мешей ${meshesA}`);
        await clearModels(page);
        await resetInput(page);

        // B. Пресет «инженерка» на файле из стен: понятная ошибка, модель не остаётся
        await setPreset(page, 'mep');
        await page.setInputFiles('#localFileInput', gridPath);
        const errToast = await page
            .waitForFunction(
                () => [...document.querySelectorAll('.toast .toast-text')]
                    .some((t) => /пресет загрузки/i.test(t.textContent)),
                { timeout: 60_000 }
            )
            .then(() => true).catch(() => false);
        if (!errToast) problems.push('пресет «инженерка»: нет понятной ошибки про отфильтрованные элементы');
        const modelsB = await page.evaluate(() => window.BimLvaDebug.modelCount);
        if (modelsB !== 0) problems.push(`пресет «инженерка»: модель осталась в сцене (${modelsB})`);
        console.log(`B. пресет «инженерка»: ошибка показана=${errToast}, моделей=${modelsB}`);
        await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));
        await resetInput(page);

        // C. Удаление выделенного из сцены (пресет «вся модель»)
        await setPreset(page, 'all');
        await page.setInputFiles('#localFileInput', gridPath);
        await waitModels(page, 1);
        const meshesBefore = await page.evaluate(() => window.BimLvaDebug.meshCount);
        await page.evaluate(() => document.getElementById('treeSelectAll').click());
        await page.waitForTimeout(300);
        await page.evaluate(() => document.getElementById('ctxDeleteStage').click());
        const deleted = await page
            .waitForFunction(() => window.BimLvaDebug.modelCount === 0, { timeout: 30_000 })
            .then(() => true).catch(() => false);
        const okToast = await page.evaluate(() =>
            [...document.querySelectorAll('.toast .toast-text')].some((t) => /Удалено из сцены/i.test(t.textContent)));
        if (!deleted) problems.push('удаление: модель не выгрузилась после удаления всех элементов');
        if (!okToast) problems.push('удаление: нет уведомления «Удалено из сцены»');
        console.log(`C. удаление: мешей было ${meshesBefore}, модель выгружена=${deleted}, тост=${okToast}`);
        await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));
        await resetInput(page);

        // D. Координаты точки вставки
        await page.setInputFiles('#localFileInput', gridPath);
        await waitModels(page, 1);
        const centerBefore = await page.evaluate(() => window.BimLvaDebug.modelBounds[0]);
        await page.evaluate(() => document.getElementById('btnAlign').click());
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            document.getElementById('alignPosX').value = '100';
            document.getElementById('alignPosY').value = '200';
            document.getElementById('alignPosZ').value = '5';
            document.getElementById('alignApplyPos').click();
        });
        await page.waitForTimeout(300);
        const centerAfter = await page.evaluate(() => window.BimLvaDebug.modelBounds[0]);
        const moved = Math.hypot(
            centerAfter.centerX - centerBefore.centerX,
            centerAfter.centerY - centerBefore.centerY,
            centerAfter.centerZ - centerBefore.centerZ
        );
        if (!(moved > 1)) problems.push(`координаты: модель не сдвинулась (Δ=${moved.toFixed(3)} м)`);
        // Закрыть и снова открыть — поля должны прочитать те же координаты
        await page.evaluate(() => document.getElementById('alignDoneBtn').click());
        await page.evaluate(() => document.getElementById('btnAlign').click());
        await page.waitForTimeout(300);
        const roundTrip = await page.evaluate(() => ({
            x: parseFloat(document.getElementById('alignPosX').value),
            y: parseFloat(document.getElementById('alignPosY').value),
            z: parseFloat(document.getElementById('alignPosZ').value)
        }));
        const rtOk = Math.abs(roundTrip.x - 100) < 0.01 && Math.abs(roundTrip.y - 200) < 0.01 && Math.abs(roundTrip.z - 5) < 0.01;
        if (!rtOk) problems.push(`координаты: после переоткрытия поля читают ${JSON.stringify(roundTrip)}, ожидалось 100/200/5`);
        console.log(`D. координаты: сдвиг ${moved.toFixed(1)} м, round-trip ok=${rtOk}`);
        await page.evaluate(() => document.getElementById('alignDoneBtn').click());
        await clearModels(page);
        await resetInput(page);

        // E. Пачка файлов: лоадер не «моргает» (не прячется между файлами)
        let sawHiddenMidBatch = false;
        let sawLoader = false;
        let modelsSeen = 0;
        const watcher = setInterval(async () => {
            try {
                const st = await page.evaluate(() => ({
                    shown: document.getElementById('loader')?.classList.contains('show') || false,
                    models: window.BimLvaDebug?.modelCount || 0
                }));
                if (st.shown) sawLoader = true;
                // Первый файл уже загружен, но лоадер скрыт до конца пачки — это и есть моргание
                if (sawLoader && !st.shown && st.models === 1) sawHiddenMidBatch = true;
                modelsSeen = st.models;
            } catch (_) {}
        }, 60);
        await page.setInputFiles('#localFileInput', [gridPath, dxfPath]);
        await waitModels(page, 2, 120_000);
        clearInterval(watcher);
        const loaderHidden = await page
            .waitForFunction(() => !document.getElementById('loader').classList.contains('show'), { timeout: 15_000 })
            .then(() => true).catch(() => false);
        if (!sawLoader) problems.push('пачка: лоадер вообще не показался');
        if (sawHiddenMidBatch) problems.push('пачка: лоадер спрятался между файлами (моргание осталось)');
        if (!loaderHidden) problems.push('пачка: лоадер не скрылся после завершения');
        console.log(`E. пачка: моделей ${modelsSeen}, лоадер был=${sawLoader}, моргал=${sawHiddenMidBatch}, скрылся=${loaderHidden}`);

        // F. IFC4X1 (Civil 3D / OpenRoads) открывается в режиме совместимости
        await clearModels(page);
        await resetInput(page);
        const ifc4x1Path = path.join(ROOT, 'tools', 'fixtures', 'feature-grid-4x1.ifc');
        await fs.writeFile(ifc4x1Path, makeGridIfc().replace("FILE_SCHEMA(('IFC4'));", "FILE_SCHEMA(('IFC4X1'));"));
        try {
            await page.setInputFiles('#localFileInput', ifc4x1Path);
            const loaded4x1 = await page
                .waitForFunction(() => window.BimLvaDebug?.modelCount === 1 && window.BimLvaDebug.meshCount > 0, { timeout: 90_000 })
                .then(() => true).catch(() => false);
            const compatToast = await page.evaluate(() =>
                [...document.querySelectorAll('.toast .toast-text')].some((t) => /IFC4X1/i.test(t.textContent) && /совместимост/i.test(t.textContent)));
            const meshes4x1 = await page.evaluate(() => window.BimLvaDebug.meshCount);
            if (!loaded4x1) problems.push('IFC4X1: файл не загрузился в режиме совместимости');
            if (!compatToast) problems.push('IFC4X1: нет предупреждения о режиме совместимости');
            console.log(`F. IFC4X1: загружен=${loaded4x1}, мешей ${meshes4x1}, предупреждение=${compatToast}`);
        } finally {
            await fs.rm(ifc4x1Path, { force: true });
        }
        // E2. Список файлов пачки: строки, отметки, отсутствие мигания и
        // монотонная полоса (раньше она откатывалась на каждом файле).
        await clearModels(page);
        await resetInput(page);
        const badPath = path.join(ROOT, 'tools', 'fixtures', 'feature-broken.ifc');
        const skipPath = path.join(ROOT, 'tools', 'fixtures', 'feature-unknown.xyz');
        await fs.writeFile(badPath, 'ISO-10303-21;\nHEADER;\nFILE_SCHEMA((\'IFC4\'));\nENDSEC;\nDATA;\nENDSEC;\n'); // без END-ISO → ошибка
        await fs.writeFile(skipPath, 'не модель');
        let hidMidBatch = false;
        let sawLoader2 = false;
        let progressWentBack = false;
        let lastPct = -1;
        const watch2 = setInterval(async () => {
            try {
                const st = await page.evaluate(() => ({
                    shown: document.getElementById('loader')?.classList.contains('show') || false,
                    rows: document.querySelectorAll('#loadFiles .load-file-row').length,
                    pct: parseInt(document.getElementById('loadTrack')?.getAttribute('aria-valuenow') || '-1', 10),
                    title: document.getElementById('loadTitle')?.textContent || ''
                }));
                if (st.shown) sawLoader2 = true;
                if (sawLoader2 && !st.shown && st.rows > 0) hidMidBatch = true;
                if (st.shown && st.pct >= 0 && lastPct >= 0 && st.pct < lastPct - 2) progressWentBack = true;
                if (st.shown && st.pct >= 0) lastPct = st.pct;
            } catch (_) {}
        }, 50);
        await page.setInputFiles('#localFileInput', [gridPath, badPath, skipPath, dxfPath]);
        // Итог с ошибками остаётся на экране до нажатия «Закрыть»
        const summary = await page
            .waitForFunction(() => !document.getElementById('loadFilesActions').hidden, { timeout: 180_000 })
            .then(() => true).catch(() => false);
        clearInterval(watch2);
        const rows = await page.evaluate(() => [...document.querySelectorAll('#loadFiles .load-file-row')].map((r) => ({
            name: r.querySelector('.lf-name').textContent,
            ico: r.querySelector('.lf-ico').textContent,
            cls: [...r.classList].filter((c) => c.startsWith('is-')).join(',')
        })));
        const sub = await page.evaluate(() => document.getElementById('loadSub').textContent);
        if (!summary) problems.push('итог пачки не показан (нет кнопки «Закрыть»)');
        if (rows.length !== 4) problems.push(`строк в списке ${rows.length}, ожидалось 4`);
        if (hidMidBatch) problems.push('загрузчик прятался посреди пачки — мигание осталось');
        if (progressWentBack) problems.push('полоса прогресса откатывалась назад по ходу пачки');
        const okRows = rows.filter((r) => r.cls.includes('is-ok')).length;
        const failRows = rows.filter((r) => r.cls.includes('is-fail')).length;
        const skipRows = rows.filter((r) => r.cls.includes('is-skip')).length;
        if (okRows !== 2) problems.push(`удачных строк ${okRows}, ожидалось 2 (ifc + dxf)`);
        if (failRows !== 1) problems.push(`строк с ошибкой ${failRows}, ожидалась 1 (битый ifc)`);
        if (skipRows !== 1) problems.push(`пропущенных строк ${skipRows}, ожидалась 1 (.xyz)`);
        if (!/Загружено 2 из 4/.test(sub)) problems.push(`итоговая подпись «${sub}»`);
        console.log(`E2. список: ${rows.length} строк — ок ${okRows}, ошибка ${failRows}, пропуск ${skipRows}; «${sub}»`);
        console.log(`    мигание=${hidMidBatch}, откат полосы=${progressWentBack}`);
        await page.evaluate(() => document.getElementById('loadFilesClose').click());
        await fs.rm(badPath, { force: true });
        await fs.rm(skipPath, { force: true });

        // G. Журнал уведомлений: копит всё, что было, даже после закрытия тостов
        const logState = await page.evaluate(async () => {
            const badgeBefore = document.getElementById('notifyLogBadge').hidden;
            window.BimLvaNotify.error('Проверка журнала — сообщение один');
            window.BimLvaNotify.ok('Проверка журнала — сообщение два');
            // Закрываем тосты: журнал не должен их терять
            document.querySelectorAll('.toast .toast-close').forEach((b) => b.click());
            const badgeShown = !document.getElementById('notifyLogBadge').hidden;
            const badgeText = document.getElementById('notifyLogBadge').textContent;
            document.getElementById('btnNotifyLog').click();
            const rows = document.querySelectorAll('#notifyLogList .notify-log-row').length;
            const html = document.getElementById('notifyLogList').textContent;
            const badgeAfterOpen = document.getElementById('notifyLogBadge').hidden;
            const modalShown = document.getElementById('notifyLogModal').classList.contains('show');
            document.getElementById('notifyLogClose').click();
            return { badgeBefore, badgeShown, badgeText, rows, modalShown, badgeAfterOpen,
                hasOne: /сообщение один/.test(html), hasTwo: /сообщение два/.test(html) };
        });
        if (!logState.badgeShown) problems.push('журнал: бейдж непрочитанных не появился');
        if (!logState.modalShown) problems.push('журнал: модалка не открылась');
        if (!logState.hasOne || !logState.hasTwo) problems.push('журнал: сообщения не сохранились после закрытия тостов');
        if (!logState.badgeAfterOpen) problems.push('журнал: бейдж не сбросился после открытия');
        // Журнал должен содержать и более ранние сообщения сессии, не только эти два
        if (!(logState.rows > 2)) problems.push(`журнал: только ${logState.rows} записей — ранние уведомления сессии потерялись`);
        console.log(`G. журнал: записей ${logState.rows}, бейдж «${logState.badgeText}», оба сообщения на месте=${logState.hasOne && logState.hasTwo}, бейдж сброшен=${logState.badgeAfterOpen}`);
    } finally {
        await fs.rm(gridPath, { force: true });
        await fs.rm(dxfPath, { force: true });
        await browser.close();
        server.close();
    }

    if (problems.length) {
        console.error('\nПроблемы (' + problems.length + '):');
        problems.forEach((p) => console.error('  · ' + p));
        process.exit(1);
    }
    console.log('\nOK — все проверки новых фич прошли.');
}

main().catch((e) => { console.error(e); process.exit(1); });
