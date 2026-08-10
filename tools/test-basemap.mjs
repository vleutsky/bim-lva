/**
 * Карта-подложка. Настоящие тайл-серверы из песочницы закрыты прокси, поэтому
 * перехватываем запросы и отдаём сгенерированный PNG: проверяем не сеть, а
 * нашу математику — что подложка встала по привязке, нужного размера, и что UV
 * считается по Меркатору, а не линейно.
 */
import { chromium } from 'playwright';
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

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

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => { problems.push('pageerror: ' + e.message); console.error('pageerror:', e.message); });
page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.error('console.error:', m.text().slice(0, 200));
});

const tileUrls = [];
for (const pattern of ['**/tile.openstreetmap.org/**', '**/server.arcgisonline.com/**']) {
    await page.route(pattern, (route) => {
        tileUrls.push(route.request().url());
        route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX });
    });
}

const SITE = { lat: 55.7, lon: 52.4 };          // Набережные Челны: искажение Меркатора ~1.77
const MODEL = { worldX: 456_000, worldY: 6_188_000, worldZ: 60 };
const RADIUS = 800;
const file = path.join(ROOT, 'tools', 'fixtures', 'basemap-geo.ifc');
await fs.writeFile(file, makeGeoIfc({ ...MODEL, count: 60, cols: 10, seed: 3, name: 'basemap-geo.ifc' }));

try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await page.setInputFiles('#localFileInput', file);
    await page.waitForFunction(
        () => window.BimLvaDebug?.modelCount === 1 && (window.BimLvaDebug?.modelBounds || []).length === 1,
        { timeout: 90_000 }
    );
    await page.waitForFunction(() => !document.getElementById('loader').classList.contains('show'), { timeout: 30_000 });
    const modelBounds = await page.evaluate(() => window.BimLvaDebug.modelBounds[0]);

    // A. Модалка: провайдеры, атрибуция, автоподстановка точки привязки
    await page.evaluate(() => document.getElementById('btnBaseMap').click());
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => ({
        shown: document.getElementById('baseMapModal').classList.contains('show'),
        anchorX: parseFloat(document.getElementById('baseMapAnchorX').value),
        anchorY: parseFloat(document.getElementById('baseMapAnchorY').value),
        providers: [...document.getElementById('baseMapProvider').options].map((o) => o.value),
        attribution: document.getElementById('baseMapAttribution').textContent,
        templateHidden: document.getElementById('baseMapTemplateRow').style.display === 'none'
    }));
    if (!opened.shown) problems.push('модалка карты не открылась');
    if (opened.providers.length < 3) problems.push(`провайдеров ${opened.providers.length}, ожидалось ≥3`);
    if (!/OpenStreetMap/i.test(opened.attribution)) problems.push('не показан источник карты (атрибуция обязательна)');
    if (!opened.templateHidden) problems.push('поле своего шаблона видно для OSM');
    const anchorOk = Math.abs(opened.anchorX - MODEL.worldX) < 300 && Math.abs(opened.anchorY - MODEL.worldY) < 300;
    if (!anchorOk) problems.push(`точка привязки (${opened.anchorX}, ${opened.anchorY}) не совпала с центром модели`);
    console.log(`A. модалка: провайдеры [${opened.providers}], привязка (${opened.anchorX.toFixed(0)}, ${opened.anchorY.toFixed(0)})`);

    // Свой шаблон должен открывать поле ввода
    const customShown = await page.evaluate(() => {
        const sel = document.getElementById('baseMapProvider');
        sel.value = 'custom';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const shown = document.getElementById('baseMapTemplateRow').style.display !== 'none';
        sel.value = 'osm';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return shown;
    });
    if (!customShown) problems.push('для своего шаблона не появилось поле URL');

    // A2. Пара из карт вставляется одной строкой и раскладывается по полям
    const pasted = await page.evaluate(([lat, lon]) => {
        const el = document.getElementById('baseMapLatLonPaste');
        el.value = `${lat}, ${lon}`;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return {
            lat: parseFloat(document.getElementById('baseMapLat').value),
            lon: parseFloat(document.getElementById('baseMapLon').value)
        };
    }, [SITE.lat, SITE.lon]);
    if (Math.abs(pasted.lat - SITE.lat) > 1e-6 || Math.abs(pasted.lon - SITE.lon) > 1e-6) {
        problems.push(`вставка пары координат не разложилась: ${JSON.stringify(pasted)}`);
    }
    // Русская локаль отдаёт дробь через запятую — самый частый способ всё сломать
    const pastedComma = await page.evaluate(() => {
        const el = document.getElementById('baseMapLatLonPaste');
        el.value = '55,712345, 52,412345';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return {
            lat: parseFloat(document.getElementById('baseMapLat').value),
            lon: parseFloat(document.getElementById('baseMapLon').value)
        };
    });
    if (Math.abs(pastedComma.lat - 55.712345) > 1e-6 || Math.abs(pastedComma.lon - 52.412345) > 1e-6) {
        problems.push(`вставка с запятой в дробной части разобрана неверно: ${JSON.stringify(pastedComma)}`);
    }
    console.log(`A2. вставка «${SITE.lat}, ${SITE.lon}» → ${pasted.lat} / ${pasted.lon}; «55,712345, 52,412345» → ${pastedComma.lat} / ${pastedComma.lon}`);

    // A3. Ввод «как получится»: у type="number" браузер молча выбрасывает
    // запятую («55,712345» → 55712345), и подложка отказывалась строиться.
    // Поля переведены в text, поэтому проверяем именно набор с клавиатуры.
    const typedCases = [
        ['55,712345', 55.712345, 'запятая как разделитель дроби'],
        ['55.712345', 55.712345, 'точка'],
        ['55.712345, 52.412345', 55.712345, 'пара вставлена прямо в «Широту»'],
        ['55 712,5', 55712.5, 'пробел-разряд не должен терять цифры']
    ];
    for (const [typed, expect, what] of typedCases) {
        const got = await page.evaluate((text) => {
            const el = document.getElementById('baseMapLat');
            el.value = '';
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return {
                lat: window.BimLvaDebug.parseDecimalProbe(document.getElementById('baseMapLat').value),
                lon: document.getElementById('baseMapLon').value
            };
        }, typed);
        if (Math.abs(got.lat - expect) > 1e-6) {
            problems.push(`ввод «${typed}» (${what}) прочитан как ${got.lat}, ожидалось ${expect}`);
        }
    }
    console.log(`A3. ввод с запятой/пробелом/парой — все ${typedCases.length} случая читаются верно`);

    // A4. Координаты модели в поле широты → понятная ошибка, а не «от −85 до 85»
    const wrongFieldMsg = await page.evaluate(async () => {
        document.getElementById('baseMapLat').value = '2308446.98';
        document.getElementById('baseMapLon').value = '454752.50';
        document.querySelectorAll('.toast .toast-close').forEach((b) => b.click());
        document.getElementById('baseMapApply').click();
        await new Promise((r) => setTimeout(r, 800));
        return [...document.querySelectorAll('.toast .toast-text')].map((t) => t.textContent).join(' | ');
    });
    if (!/2308446\.98/.test(wrongFieldMsg) || !/шага 1|карт/i.test(wrongFieldMsg)) {
        problems.push(`при координатах модели в поле широты сообщение неинформативно: «${wrongFieldMsg.slice(0, 160)}»`);
    }
    console.log(`A4. координаты модели в поле широты → подсказка про шаг 1: ${/шага 1/.test(wrongFieldMsg) ? 'есть' : 'НЕТ'}`);
    await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));

    // B. Строим подложку
    await page.evaluate(([lat, lon, radius]) => {
        document.getElementById('baseMapLat').value = String(lat);
        document.getElementById('baseMapLon').value = String(lon);
        document.getElementById('baseMapRadius').value = String(radius);
        document.getElementById('baseMapApply').click();
    }, [SITE.lat, SITE.lon, RADIUS]);
    const built = await page
        .waitForFunction(() => window.BimLvaDebug?.basemapLayer != null, { timeout: 90_000 })
        .then(() => true).catch(() => false);
    if (!built) {
        problems.push('подложка не построилась');
    } else {
        const bm = await page.evaluate(() => window.BimLvaDebug.basemapLayer);

        // Размер: ровно 2×радиус
        const sizeOk = Math.abs(bm.sizeX - RADIUS * 2) < 1 && Math.abs(bm.sizeY - RADIUS * 2) < 1;
        if (!sizeOk) problems.push(`размер подложки ${bm.sizeX.toFixed(0)}×${bm.sizeY.toFixed(0)} вместо ${RADIUS * 2}`);

        // Положение: центр подложки = точка привязки, т.е. центр модели
        const offset = Math.hypot(bm.centerX - modelBounds.centerX, bm.centerY - modelBounds.centerY);
        if (!(offset < 300)) problems.push(`подложка съехала от модели на ${offset.toFixed(0)} м`);

        // Высота: подложка должна лежать у низа модели, а не улететь на origin
        const dz = Math.abs(bm.centerZ - modelBounds.centerZ);
        if (!(dz < 200)) problems.push(`подложка по высоте отстоит на ${dz.toFixed(0)} м — не учтён ноль сцены`);

        // Линейный UV дал бы в центре ровно (0.5, 0.5): центр плоскости —
        // это её геометрическая середина. Значит отличие доказывает, что UV
        // считается через Меркатор, а не «на глазок».
        const midDelta = Math.abs(bm.uvMid[1] - 0.5);
        if (!(midDelta > 1e-6)) problems.push('UV линейный — поправка Меркатора не применилась');

        // Главная проверка: МАСШТАБ. Тут и живёт классическая ошибка в 1/cos(широты)
        // (для 55.7° это 1.77×) — карта выглядит правдоподобно, но всё смещено.
        // Считаем аналитически, сколько тайлов должна занимать площадка по северу.
        const { zoom, spanY } = bm.tileInfo;
        const latRad = (SITE.lat * Math.PI) / 180;
        const dLat = (RADIUS * 2) / 111320;                        // градусы широты на 1600 м
        const expectedTiles = (Math.pow(2, zoom) / (2 * Math.PI)) * (1 / Math.cos(latRad)) * ((dLat * Math.PI) / 180);
        const vSpan = Math.abs(bm.uvLast[1] - bm.uvFirst[1]) * spanY; // фактически занято тайлов
        const scaleErr = Math.abs(vSpan - expectedTiles) / expectedTiles;
        if (!(scaleErr < 0.02)) {
            problems.push(
                `масштаб подложки расходится на ${(scaleErr * 100).toFixed(1)}% ` +
                `(занято ${vSpan.toFixed(2)} тайлов, по расчёту ${expectedTiles.toFixed(2)}) — ` +
                `похоже на пропущенную поправку Меркатора 1/cos(φ)=${(1 / Math.cos(latRad)).toFixed(2)}`
            );
        }

        console.log(`B. подложка: ${bm.sizeX.toFixed(0)}×${bm.sizeY.toFixed(0)} м, смещение от модели ${offset.toFixed(0)} м, Δz ${dz.toFixed(1)} м`);
        console.log(`   масштаб: занято ${vSpan.toFixed(2)} тайлов, расчёт ${expectedTiles.toFixed(2)} → расхождение ${(scaleErr * 100).toFixed(2)}%`);
        console.log(`   (без поправки Меркатора было бы ×${(1 / Math.cos(latRad)).toFixed(2)})`);
        console.log(`   прозрачность ${bm.opacity.toFixed(2)}, слой «${bm.name}»`);
    }

    // C. Тайлы: запрошены и лимит соблюдён
    const zooms = [...new Set(tileUrls.map((u) => (u.match(/\/(\d+)\/\d+\/\d+/) || [])[1]).filter(Boolean))];
    if (!tileUrls.length) problems.push('ни один тайл не запрошен');
    if (tileUrls.length > 200) problems.push(`запрошено ${tileUrls.length} тайлов — лимит не работает`);
    console.log(`C. тайлов ${tileUrls.length}, зум ${zooms.join(',')}`);

    // D. Смена прозрачности без пересборки
    const opacityChanged = await page.evaluate(() => {
        const before = window.BimLvaDebug.basemapLayer.opacity;
        const el = document.getElementById('baseMapOpacity');
        el.value = '0.35';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { before, after: window.BimLvaDebug.basemapLayer.opacity };
    });
    if (!(Math.abs(opacityChanged.after - 0.35) < 0.01)) {
        problems.push(`прозрачность не применилась вживую: ${opacityChanged.after}`);
    }
    console.log(`D. прозрачность ${opacityChanged.before.toFixed(2)} → ${opacityChanged.after.toFixed(2)}`);

    // E. Убрать подложку
    const removed = await page.evaluate(() => {
        document.getElementById('baseMapRemove').click();
        return window.BimLvaDebug.basemapLayer == null;
    });
    if (!removed) problems.push('подложка не убралась по кнопке');
    console.log(`E. удаление подложки: ${removed ? 'ок' : 'СБОЙ'}`);

    // F. Понятная ошибка, если тайлы не отдаются
    await page.route('**/tile.openstreetmap.org/**', (route) => route.abort());
    await page.evaluate(() => {
        document.getElementById('btnBaseMap').click();
        document.getElementById('baseMapApply').click();
    });
    const errShown = await page
        .waitForFunction(
            () => [...document.querySelectorAll('.toast .toast-text')].some((t) => /тайл/i.test(t.textContent)),
            { timeout: 60_000 }
        )
        .then(() => true).catch(() => false);
    if (!errShown) problems.push('при недоступных тайлах нет понятного сообщения');
    console.log(`F. недоступные тайлы: сообщение ${errShown ? 'показано' : 'НЕТ'}`);
} finally {
    await fs.rm(file, { force: true });
    await browser.close();
    server.close();
}

if (problems.length) {
    console.error('\nПроблемы (' + problems.length + '):');
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('\nOK — карта-подложка работает.');
