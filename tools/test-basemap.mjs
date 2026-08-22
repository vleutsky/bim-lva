/**
 * Карта-подложка, рельеф с карты и окно-глобус (рамка/контур до 200 га).
 * Настоящие тайл-серверы из песочницы закрыты прокси, поэтому перехватываем
 * запросы и отдаём сгенерированный PNG: проверяем не сеть, а математику —
 * привязка, размер, UV по Меркатору, формула Terrarium, лимит площади
 * и что sampleTerrainZ сверлит меш DEM, а не картинку подложки.
 */
import { chromium } from 'playwright';
import { makeGeoIfc } from './fixtures/make-geo-ifc.mjs';
import { startStaticServer } from './static-server.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

/** CRC32 для чанков PNG — без зависимости от версии Node (zlib.crc32 не везде). */
function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return (~c) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
}

/** 1×1 RGBA PNG сплошного цвета. drawImage растянет его на тайл 256×256. */
function pngRgba(r, g, b, a = 255) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.from([0, r, g, b, a]);
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return Buffer.concat([
        sig,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

// Terrarium: (R·256 + G + B/256) − 32768. Высота 60 м = MODEL.worldZ.
const TERRARIUM_Z = 60;
const PNG_TERRARIUM_60 = pngRgba(128, 60, 0, 255);

/**
 * Тайл высот С НЕРОВНОСТЬЮ на шаге собственной сетки: только на таком видно,
 * как подложка проваливается под грани рельефа. Плоский тайл выше этого не
 * показывает вовсе — проверка прошла бы вхолостую.
 */
function pngTerrariumRough(size, zAt) {
    const raw = Buffer.alloc((size * 4 + 1) * size);
    let o = 0;
    for (let y = 0; y < size; y++) {
        raw[o++] = 0;
        for (let x = 0; x < size; x++) {
            const v = Math.round((zAt(x / size, y / size) + 32768) * 256);
            raw[o++] = (v >> 16) & 255; raw[o++] = (v >> 8) & 255; raw[o++] = v & 255; raw[o++] = 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}
const PNG_TERRARIUM_ROUGH = pngTerrariumRough(256, (u, v) => TERRARIUM_Z
    + 30 * Math.sin(u * Math.PI * 6) + 20 * Math.cos(v * Math.PI * 4)
    + 20 * Math.sin(u * Math.PI * 61) * Math.cos(v * Math.PI * 59));
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Cache-Control': 'no-store'
};

async function resolveChromium() {
    const explicit = process.env.SMOKE_CHROMIUM || process.env.CHROMIUM_PATH;
    if (explicit) return explicit;
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (base) {
        const entries = await fs.readdir(base).catch(() => []);
        for (const dir of entries.filter((d) => d.startsWith('chromium-')).sort().reverse()) {
            const bin = path.join(base, dir, 'chrome-linux', 'chrome');
            if (await fs.access(bin).then(() => true, () => false)) return bin;
        }
    }
    // Песочница: ревизия Playwright не совпадает с кэшем, системный Chrome уже стоит.
    for (const bin of [
        '/usr/local/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ]) {
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
const demUrls = [];
for (const pattern of ['**/tile.openstreetmap.org/**', '**/server.arcgisonline.com/**']) {
    await page.route(pattern, (route) => {
        tileUrls.push(route.request().url());
        route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG_1PX });
    });
}
await page.route('**/elevation-tiles-prod/terrarium/**', (route) => {
    demUrls.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG_TERRARIUM_60 });
});
await page.route('**/nominatim.openstreetmap.org/**', (route) => {
    route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify([{ lat: '55.7', lon: '52.4', display_name: 'Набережные Челны' }])
    });
});

const SITE = { lat: 55.7, lon: 52.4 };          // Набережные Челны: искажение Меркатора ~1.77
const MODEL = { worldX: 456_000, worldY: 6_188_000, worldZ: 60 };
const RADIUS = 800;
const file = path.join(ROOT, 'tools', 'fixtures', 'basemap-geo.ifc');
await fs.writeFile(file, makeGeoIfc({ ...MODEL, count: 60, cols: 10, seed: 3, name: 'basemap-geo.ifc' }));

try {
    await page.goto(`http://127.0.0.1:${port}/bim-lva-composer-ifc.html`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    // A-g. Глобус без сохранённой площадки открывается на Санкт-Петербурге.
    const globeHome = await page.evaluate(async () => {
        document.getElementById('btnMapBuilder').click();
        await new Promise((r) => setTimeout(r, 400));
        const st = window.BimLvaDebug.mapBuilderState;
        document.getElementById('mapBuilderCancel').click();
        return st;
    });
    const SPB = { lat: 59.9343, lon: 30.3351 };
    if (Math.abs(globeHome.lat - SPB.lat) > 0.05 || Math.abs(globeHome.lon - SPB.lon) > 0.05) {
        problems.push(
            `глобус открылся на ${globeHome.lat?.toFixed?.(4)}, ${globeHome.lon?.toFixed?.(4)}, ` +
            `ждали Санкт-Петербург (${SPB.lat}, ${SPB.lon})`
        );
    }
    if (!(globeHome.zoom >= 10 && globeHome.zoom <= 13)) {
        problems.push(`зум глобуса ${globeHome.zoom}, ждали ~11 (город, не страна)`);
    }
    console.log(
        `A-g. глобус: ${globeHome.lat?.toFixed?.(4)}, ${globeHome.lon?.toFixed?.(4)}, зум ${globeHome.zoom}`
    );

    // A-h. Повторное открытие после зума «весь мир» возвращает город, а не планету.
    const globeReopen = await page.evaluate(async () => {
        document.getElementById('btnMapBuilder').click();
        await new Promise((r) => setTimeout(r, 200));
        window.BimLvaDebug.mapBuilderSetView(10, 20, 2);
        const lost = window.BimLvaDebug.mapBuilderState;
        document.getElementById('mapBuilderCancel').click();
        document.getElementById('btnMapBuilder').click();
        await new Promise((r) => setTimeout(r, 400));
        const restored = window.BimLvaDebug.mapBuilderState;
        document.getElementById('mapBuilderCancel').click();
        return { lost, restored };
    });
    if (!(globeReopen.lost.zoom < 10)) {
        problems.push(`зум «весь мир» не выставился: ${globeReopen.lost.zoom}`);
    }
    if (!(globeReopen.restored.zoom >= 10 && globeReopen.restored.zoom <= 13)) {
        problems.push(`повторное открытие: зум ${globeReopen.restored.zoom}, ждали город (~11)`);
    }
    if (Math.abs(globeReopen.restored.lat - SPB.lat) > 0.05 || Math.abs(globeReopen.restored.lon - SPB.lon) > 0.05) {
        problems.push(
            `повторное открытие уехало на ${globeReopen.restored.lat?.toFixed?.(4)}, ` +
            `${globeReopen.restored.lon?.toFixed?.(4)}, ждали Санкт-Петербург`
        );
    }
    console.log(
        `A-h. reopen: потерянный зум ${globeReopen.lost.zoom?.toFixed?.(1)} → ` +
        `${globeReopen.restored.lat?.toFixed?.(4)}, ${globeReopen.restored.lon?.toFixed?.(4)}, ` +
        `зум ${globeReopen.restored.zoom}`
    );

    // A-i. Поиск «Санкт-Петербург» бьёт в HOME даже если Nominatim отдаёт Челны.
    const globeSearch = await page.evaluate(async () => {
        document.getElementById('btnMapBuilder').click();
        await new Promise((r) => setTimeout(r, 200));
        window.BimLvaDebug.mapBuilderSetView(10, 20, 6);
        const q = document.getElementById('mapBuilderSearch');
        q.value = 'Санкт-Петербург';
        document.getElementById('mapBuilderSearchGo').click();
        await new Promise((r) => setTimeout(r, 400));
        const st = window.BimLvaDebug.mapBuilderState;
        const hint = document.getElementById('mapBuilderHint')?.textContent || '';
        document.getElementById('mapBuilderCancel').click();
        return { ...st, hint };
    });
    if (Math.abs(globeSearch.lat - SPB.lat) > 0.05 || Math.abs(globeSearch.lon - SPB.lon) > 0.05) {
        problems.push(
            `поиск СПб дал ${globeSearch.lat?.toFixed?.(4)}, ${globeSearch.lon?.toFixed?.(4)} — ` +
            `уехал в ответ Nominatim?`
        );
    }
    if (!(globeSearch.zoom >= 12)) {
        problems.push(`поиск СПб оставил зум ${globeSearch.zoom}, ждали город`);
    }
    if (!/Санкт-Петербург/i.test(globeSearch.hint)) {
        problems.push(`подпись после поиска СПб: «${globeSearch.hint.slice(0, 80)}»`);
    }
    console.log(
        `A-i. поиск СПб: ${globeSearch.lat?.toFixed?.(4)}, ${globeSearch.lon?.toFixed?.(4)}, ` +
        `зум ${globeSearch.zoom}, «${globeSearch.hint.slice(0, 40)}»`
    );

    // A-j. Без алиаса — Nominatim (мок = Набережные Челны).
    const globeNom = await page.evaluate(async () => {
        document.getElementById('btnMapBuilder').click();
        await new Promise((r) => setTimeout(r, 200));
        const q = document.getElementById('mapBuilderSearch');
        q.value = 'Набережные Челны';
        document.getElementById('mapBuilderSearchGo').click();
        await new Promise((r) => setTimeout(r, 500));
        const st = window.BimLvaDebug.mapBuilderState;
        document.getElementById('mapBuilderCancel').click();
        return st;
    });
    if (Math.abs(globeNom.lat - 55.7) > 0.05 || Math.abs(globeNom.lon - 52.4) > 0.05) {
        problems.push(
            `поиск без алиаса: ${globeNom.lat?.toFixed?.(4)}, ${globeNom.lon?.toFixed?.(4)}, ` +
            `ждали мок Челны (55.7, 52.4)`
        );
    }
    if (!(globeNom.zoom >= 12)) problems.push(`поиск Челны зум ${globeNom.zoom}`);
    console.log(
        `A-j. поиск Челны (Nominatim): ${globeNom.lat?.toFixed?.(4)}, ${globeNom.lon?.toFixed?.(4)}, ` +
        `зум ${globeNom.zoom}`
    );

    const mLat0 = 111320;
    const mLon0 = 111320 * Math.cos((SITE.lat * Math.PI) / 180);
    const dLat0 = 400 / mLat0;
    const dLon0 = 400 / mLon0;
    const emptyRect = [
        SITE,
        { lat: SITE.lat - dLat0, lon: SITE.lon - dLon0 },
        { lat: SITE.lat + dLat0, lon: SITE.lon + dLon0 }
    ];

    async function loadMapOnEmptyScene(place) {
        await page.evaluate(([site, a, b, placeMode]) => {
            document.getElementById('btnMapBuilder').click();
            window.BimLvaDebug.mapBuilderSetPlace(placeMode);
            window.BimLvaDebug.mapBuilderSetView(site.lat, site.lon, 14);
            window.BimLvaDebug.mapBuilderDrawRect(a, b);
            document.getElementById('mapBuilderLoad').click();
        }, [...emptyRect, place]);
        return page
            .waitForFunction(
                () => window.BimLvaDebug?.mapTerrainLayer != null
                    && window.BimLvaDebug?.basemapLayer != null
                    && !document.getElementById('mapBuilderModal')?.classList.contains('show')
                    && !document.getElementById('loader')?.classList.contains('show'),
                { timeout: 90_000 }
            )
            .then(() => true).catch(() => false);
    }

    async function clearMapScene() {
        await page.evaluate(() => document.getElementById('clear')?.click());
        await page.waitForFunction(
            () => window.BimLvaDebug.modelCount === 0
                && window.BimLvaDebug.mapTerrainLayer == null
                && window.BimLvaDebug.worldOrigin == null
                && !document.getElementById('loader')?.classList.contains('show'),
            { timeout: 30_000 }
        );
        await page.evaluate(() => window.BimLvaDebug.clearBasemapBinding());
    }

    // A-k. Пустая сцена → карта: координаты «в нули» и лента черчения.
    const emptyTools = await page.evaluate(() => ({
        draw: !!document.getElementById('btnDraw')?.disabled,
        axis: !!document.getElementById('btnRoadAxis')?.disabled,
        pad: !!document.getElementById('btnPadList')?.disabled,
        sweep: !!document.getElementById('btnSweep')?.disabled
    }));
    if (!emptyTools.draw || !emptyTools.axis || !emptyTools.pad || !emptyTools.sweep) {
        problems.push(`на пустой сцене инструменты уже включены: ${JSON.stringify(emptyTools)}`);
    }
    const zerosOk = await loadMapOnEmptyScene('zeros');
    if (!zerosOk) {
        problems.push('карта «в нули» на пустой сцене не загрузила рельеф');
    } else {
        const zeros = await page.evaluate(() => {
            const dem = window.BimLvaDebug.mapTerrainLayer;
            const abs = window.BimLvaDebug.worldPointToAbsolute(dem.centerX, dem.centerY, dem.centerZ);
            const ids = [
                'btnDraw', 'drawModeSelect', 'btnRoadAxis', 'btnRoadXs',
                'btnPadList', 'btnSweep', 'btnMeasure', 'btnPolylineList'
            ];
            const disabled = Object.fromEntries(ids.map((id) => [id, !!document.getElementById(id)?.disabled]));
            document.getElementById('btnDraw')?.click();
            const drawing = document.getElementById('btnDraw')?.classList.contains('on');
            if (drawing) document.getElementById('btnDraw')?.click();
            document.getElementById('btnRoadAxis')?.click();
            const axisOn = document.getElementById('btnRoadAxis')?.classList.contains('on');
            if (axisOn) document.getElementById('btnRoadAxis')?.click();
            return {
                origin: window.BimLvaDebug.worldOrigin,
                sceneXY: Math.hypot(dem.centerX, dem.centerY),
                absX: abs.x,
                absY: abs.y,
                absZ: abs.z,
                sample: window.BimLvaDebug.sampleTerrainZ(dem.centerX, dem.centerY, Number.NaN),
                disabled,
                drawing,
                axisOn,
                tools: window.BimLvaDebug.mapSite?.tools || null
            };
        });
        if (zeros.origin) {
            problems.push(`режим «нули» задал origin ${JSON.stringify(zeros.origin)}`);
        }
        if (!(zeros.sceneXY < 50)) {
            problems.push(`режим «нули»: центр сцены ${zeros.sceneXY.toFixed(1)} м от нуля`);
        }
        if (!(Math.abs(zeros.absX) < 50 && Math.abs(zeros.absY) < 50)) {
            problems.push(
                `режим «нули»: абсолютные (${zeros.absX.toFixed(1)}, ${zeros.absY.toFixed(1)}), ждали ~0`
            );
        }
        if (!(Math.abs(zeros.absZ - TERRARIUM_Z) < 5)) {
            problems.push(`режим «нули»: Z=${zeros.absZ?.toFixed?.(2)}, ждали DEM ${TERRARIUM_Z}`);
        }
        if (!(Number.isFinite(zeros.sample) && Math.abs(zeros.sample - TERRARIUM_Z) < 5)) {
            problems.push(`режим «нули»: sampleTerrainZ=${zeros.sample}`);
        }
        const blocked = Object.entries(zeros.disabled).filter(([, d]) => d).map(([id]) => id);
        if (blocked.length) {
            problems.push(`после карты на пустой сцене заблокированы: ${blocked.join(', ')}`);
        }
        if (!zeros.drawing) problems.push('после карты «Полилиния» не включилась');
        if (!zeros.axisOn) problems.push('после карты «Ось трассы» не включилась');
        console.log(
            `A-k. нули: сцена ${zeros.sceneXY.toFixed(1)} м, ` +
            `абс (${zeros.absX.toFixed(1)}, ${zeros.absY.toFixed(1)}, ${zeros.absZ.toFixed(1)}), ` +
            `DEM ${Number.isFinite(zeros.sample) ? zeros.sample.toFixed(1) : 'NaN'}, ` +
            `лента ${blocked.length ? 'блок ' + blocked.join(',') : 'вкл'}, ` +
            `ось ${zeros.axisOn ? 'ок' : 'НЕТ'}`
        );
        await clearMapScene();
        const afterClear = await page.evaluate(() => ({
            axis: !!document.getElementById('btnRoadAxis')?.disabled,
            pad: !!document.getElementById('btnPadList')?.disabled
        }));
        if (!afterClear.axis || !afterClear.pad) {
            problems.push(`после очистки оси/площадки остались включёнными: ${JSON.stringify(afterClear)}`);
        }
    }

    // A-l. Пустая сцена, мировые ГК: статус-бар ≈ TM(55.7, 52.4), сцена у нуля.
    const worldOk = await loadMapOnEmptyScene('world');
    if (!worldOk) {
        problems.push('карта «мировые» на пустой сцене не загрузила рельеф');
    } else {
        const world = await page.evaluate(([lat, lon]) => {
            const dem = window.BimLvaDebug.mapTerrainLayer;
            const abs = window.BimLvaDebug.worldPointToAbsolute(dem.centerX, dem.centerY, dem.centerZ);
            const tm = window.BimLvaDebug.wgs84TmEn(lat, lon);
            const origin = window.BimLvaDebug.worldOrigin;
            return {
                tm,
                origin,
                sceneXY: Math.hypot(dem.centerX, dem.centerY),
                absX: abs.x,
                absY: abs.y,
                absZ: abs.z,
                sample: window.BimLvaDebug.sampleTerrainZ(dem.centerX, dem.centerY, Number.NaN),
                placeLocked: window.BimLvaDebug.mapBuilderState?.placeLocked
            };
        }, [SITE.lat, SITE.lon]);
        if (!(world.tm.zone === 9 && world.tm.e > 9e6 && world.tm.e < 1e7
            && world.tm.n > 6e6 && world.tm.n < 6.4e6)) {
            problems.push(`ГК Челны странные: ${JSON.stringify(world.tm)}`);
        }
        if (!world.origin || world.origin.frame !== 'external') {
            problems.push(`режим «мировые» не задал origin external: ${JSON.stringify(world.origin)}`);
        }
        if (world.origin && Math.hypot(world.origin.x - world.tm.e, world.origin.y - world.tm.n) > 1) {
            problems.push(
                `origin (${world.origin.x.toFixed(0)}, ${world.origin.y.toFixed(0)}) ` +
                `≠ TM (${world.tm.e.toFixed(0)}, ${world.tm.n.toFixed(0)})`
            );
        }
        if (!(world.sceneXY < 50)) {
            problems.push(`режим «мировые»: центр сцены ${world.sceneXY.toFixed(1)} м — float32 без origin?`);
        }
        if (!(Math.hypot(world.absX - world.tm.e, world.absY - world.tm.n) < 5)) {
            problems.push(
                `режим «мировые»: абс (${world.absX.toFixed(1)}, ${world.absY.toFixed(1)}), ` +
                `ждали TM (${world.tm.e.toFixed(1)}, ${world.tm.n.toFixed(1)})`
            );
        }
        if (!(Math.abs(world.absZ - TERRARIUM_Z) < 5)) {
            problems.push(`режим «мировые»: Z=${world.absZ?.toFixed?.(2)}, ждали DEM ${TERRARIUM_Z}`);
        }
        if (!(Number.isFinite(world.sample) && Math.abs(world.sample - TERRARIUM_Z) < 5)) {
            problems.push(`режим «мировые»: sampleTerrainZ=${world.sample}`);
        }
        console.log(
            `A-l. мировые: зона ${world.tm.zone}, ` +
            `абс (${world.absX.toFixed(0)}, ${world.absY.toFixed(0)}), ` +
            `сцена ${world.sceneXY.toFixed(1)} м, DEM ${Number.isFinite(world.sample) ? world.sample.toFixed(1) : 'NaN'}`
        );
        await clearMapScene();
    }

    await page.setInputFiles('#localFileInput', file);
    await page.waitForFunction(
        () => window.BimLvaDebug?.modelCount === 1 && (window.BimLvaDebug?.modelBounds || []).length === 1,
        { timeout: 90_000 }
    );
    await page.waitForFunction(() => !document.getElementById('loader').classList.contains('show'), { timeout: 30_000 });
    const modelBounds = await page.evaluate(() => window.BimLvaDebug.modelBounds[0]);

    // A-1. Точка привязки должна совпадать со строкой состояния. Складывать
    // габарит с ifcWorldOrigin напрямую нельзя: сцена после загрузки ещё
    // до-центрируется, и на эту величину привязка (а с ней вся подложка) уезжала.
    const anchorVsReadout = await page.evaluate(async () => {
        document.getElementById('treeSelectAll').click();
        await new Promise((r) => setTimeout(r, 500));
        const readout = document.getElementById('coordSelection').textContent;
        document.getElementById('btnBaseMap').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('mapBuilderBind').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('baseMapAnchorSelection').click();
        const fromSelection = {
            x: parseFloat(document.getElementById('baseMapAnchorX').value),
            y: parseFloat(document.getElementById('baseMapAnchorY').value)
        };
        document.getElementById('baseMapAnchorCenter').click();
        const fromCenter = {
            x: parseFloat(document.getElementById('baseMapAnchorX').value),
            y: parseFloat(document.getElementById('baseMapAnchorY').value)
        };
        document.getElementById('baseMapCancel').click();
        return { readout, fromSelection, fromCenter };
    });
    // Строка состояния печатает «+E · +N · +Z» — сверяем с ней
    const readoutNums = (anchorVsReadout.readout.match(/-?[\d.]+/g) || []).map(Number);
    const okSel = readoutNums.length >= 2 &&
        Math.abs(anchorVsReadout.fromSelection.x - readoutNums[0]) < 1 &&
        Math.abs(anchorVsReadout.fromSelection.y - readoutNums[1]) < 1;
    if (!okSel) {
        problems.push(
            `«Из выделения» дало (${anchorVsReadout.fromSelection.x}, ${anchorVsReadout.fromSelection.y}), ` +
            `а строка состояния показывает «${anchorVsReadout.readout}» — привязка разъедется`
        );
    }
    if (Math.abs(anchorVsReadout.fromCenter.x - MODEL.worldX) > 500) {
        problems.push(`«Центр моделей» дал ${anchorVsReadout.fromCenter.x}, ожидалось около ${MODEL.worldX}`);
    }
    console.log(`A-1. привязка «из выделения» (${anchorVsReadout.fromSelection.x.toFixed(2)}, ${anchorVsReadout.fromSelection.y.toFixed(2)}) = строка состояния «${anchorVsReadout.readout.trim().slice(0, 40)}»`);

    // A0. До привязки карты кнопка копирует плоские координаты модели и
    // объясняет, как получать широту с долготой. Это первый сценарий у любого.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const beforeBinding = await page.evaluate(async () => {
        document.getElementById('treeSelectAll').click();
        await new Promise((r) => setTimeout(r, 400));
        document.querySelectorAll('.toast .toast-close').forEach((b) => b.click());
        document.getElementById('coordSelectionCopy').click();
        await new Promise((r) => setTimeout(r, 400));
        return {
            clip: await navigator.clipboard.readText(),
            toast: [...document.querySelectorAll('.toast .toast-text')].map((t) => t.textContent).join(' | ')
        };
    });
    const plainNums = (beforeBinding.clip || '').split(',').map((s) => parseFloat(s.trim()));
    if (plainNums.length !== 3 || !(Math.abs(plainNums[0] - MODEL.worldX) < 500)) {
        problems.push(`без привязки скопировано «${beforeBinding.clip}», ожидались плоские координаты модели`);
    }
    if (!/привяжите карту/i.test(beforeBinding.toast)) {
        problems.push('без привязки нет подсказки, как получить широту и долготу');
    }
    console.log(`A0. до привязки копируются плоские координаты: «${beforeBinding.clip}»`);
    await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));

    // A. Глобус (InfraWorks-style), оттуда — старый диалог привязки
    await page.evaluate(() => document.getElementById('btnBaseMap').click());
    await page.waitForTimeout(400);
    const globe = await page.evaluate(() => ({
        shown: document.getElementById('mapBuilderModal').classList.contains('show'),
        loadDisabled: document.getElementById('mapBuilderLoad').disabled,
        title: document.getElementById('mapBuilderTitle')?.textContent || '',
        layers: [...document.getElementById('mapBuilderLayer').options].map((o) => o.value)
    }));
    if (!globe.shown) problems.push('окно карты-глобуса не открылось по «Карта»');
    if (!globe.loadDisabled) problems.push('«Загрузить» активно без рамки/контура');
    if (!/Площадка с карты/.test(globe.title)) problems.push(`заголовок глобуса «${globe.title}»`);
    if (!globe.layers.includes('esri') || !globe.layers.includes('osm') || globe.layers.length < 5) {
        problems.push(`слоёв глобуса [${globe.layers}], ожидались снимок, схема, топо, отмывка`);
    }
    console.log(`A-g. глобус: ${globe.shown ? 'открыт' : 'НЕТ'}, слои [${globe.layers}], Загрузить ${globe.loadDisabled ? 'выкл' : 'вкл'}`);
    await page.evaluate(() => document.getElementById('mapBuilderBind').click());
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
    if (opened.providers.length < 5) problems.push(`слоёв ${opened.providers.length}, ожидалось ≥5 (снимок, схема, топо, рельеф, свой)`);
    if (!/Источник/i.test(opened.attribution)) problems.push('не показан источник карты (атрибуция обязательна)');
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

    // A1. Рельеф с карты: предупреждение, Terrarium без шаблона, Terrain-RGB — с шаблоном
    const demUi = await page.evaluate(() => {
        const apply = document.getElementById('baseMapDemApply');
        const src = document.getElementById('baseMapDemSource');
        const row = document.getElementById('baseMapDemTemplateRow');
        const note = document.getElementById('baseMapDemNote')?.textContent || '';
        const before = {
            hasApply: !!apply,
            source: src?.value,
            templateHidden: row?.style.display === 'none',
            warns: /Рельеф с карты/.test(note) && /DEM/.test(note) && /10/.test(note) && /меш|сетк/.test(note)
        };
        src.value = 'terrainRgb';
        src.dispatchEvent(new Event('change', { bubbles: true }));
        const rgbShown = row.style.display !== 'none';
        src.value = 'terrarium';
        src.dispatchEvent(new Event('change', { bubbles: true }));
        const terrHidden = row.style.display === 'none';
        return { ...before, rgbShown, terrHidden };
    });
    if (!demUi.hasApply) problems.push('нет кнопки «Рельеф с карты»');
    if (demUi.source !== 'terrarium') problems.push(`источник высот по умолчанию «${demUi.source}», ожидался terrarium`);
    if (!demUi.templateHidden) problems.push('шаблон Terrain-RGB виден для Terrarium');
    if (!demUi.rgbShown) problems.push('для Terrain-RGB не появилось поле шаблона');
    if (!demUi.terrHidden) problems.push('после возврата на Terrarium поле шаблона осталось на экране');
    if (!demUi.warns) problems.push('нет предупреждения, что DEM — глобальный, шаг 10–30 м, не картинка');
    console.log(`A1. рельеф с карты: Terrarium, шаблон ${demUi.terrHidden ? 'скрыт' : 'виден'}, предупреждение ${demUi.warns ? 'есть' : 'НЕТ'}`);

    // A2. Пара из карт вставляется целиком в любое из двух полей и разделяется.
    // Проверяем настоящей вставкой (paste), а не подстановкой value: разделение
    // сидит именно на paste, потому что на вводе оно портило набор с клавиатуры.
    async function pasteInto(selector, text) {
        await page.locator(selector).fill('');
        await page.evaluate(([sel, value]) => {
            const el = document.querySelector(sel);
            el.focus();
            const dt = new DataTransfer();
            dt.setData('text', value);
            el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, [selector, text]);
        return page.evaluate(() => ({
            lat: parseFloat(document.getElementById('baseMapLat').value),
            lon: parseFloat(document.getElementById('baseMapLon').value)
        }));
    }
    const pasteCases = [
        ['#baseMapLat', `${SITE.lat}, ${SITE.lon}`, SITE.lat, SITE.lon, 'пара в «Широту»'],
        ['#baseMapLon', `${SITE.lat}, ${SITE.lon}`, SITE.lat, SITE.lon, 'пара в «Долготу»'],
        ['#baseMapLat', '55,712345, 52,412345', 55.712345, 52.412345, 'запятая в дробной части']
    ];
    for (const [sel, text, wantLat, wantLon, what] of pasteCases) {
        const got = await pasteInto(sel, text);
        if (Math.abs(got.lat - wantLat) > 1e-6 || Math.abs(got.lon - wantLon) > 1e-6) {
            problems.push(`вставка «${text}» (${what}) дала ${got.lat} / ${got.lon}, ожидалось ${wantLat} / ${wantLon}`);
        }
    }
    console.log(`A2. вставка пары — все ${pasteCases.length} случая (в «Широту», в «Долготу», с запятой) разделяются верно`);

    // A2b. Набор пары руками не должен портить значение: разделение на каждом
    // нажатии обрезало широту и дописывало к ней остаток строки.
    await page.locator('#baseMapLat').fill('');
    await page.locator('#baseMapLat').type('55.712345');
    const typedLat = await page.evaluate(() => document.getElementById('baseMapLat').value);
    if (typedLat !== '55.712345') {
        problems.push(`набор широты с клавиатуры испорчен: получено «${typedLat}» вместо «55.712345»`);
    }
    console.log(`A2b. набор с клавиатуры: «${typedLat}»`);

    // A2c. Пустое поле — отдельное понятное сообщение, а не «не градусы»
    const emptyMsg = await page.evaluate(async () => {
        document.getElementById('baseMapLat').value = '';
        document.getElementById('baseMapLon').value = '';
        document.querySelectorAll('.toast .toast-close').forEach((b) => b.click());
        document.getElementById('baseMapApply').click();
        await new Promise((r) => setTimeout(r, 600));
        return [...document.querySelectorAll('.toast .toast-text')].map((t) => t.textContent).join(' | ');
    });
    if (!/Не заполнено поле «Широта»/.test(emptyMsg)) {
        problems.push(`при пустом поле сообщение неверное: «${emptyMsg.slice(0, 140)}»`);
    }
    console.log(`A2c. пустое поле → «${(emptyMsg.split('\n')[0] || '').slice(0, 60)}»`);
    await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));

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

    // B2. Копирование координат из строки состояния. Показания под курсором
    // переписываются на каждое движение мыши, выделить их мышью нельзя —
    // поэтому проверяем именно кнопку и то, что после привязки карты она
    // отдаёт широту/долготу в формате поиска Яндекс.Карт.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const copied = await page.evaluate(async () => {
        // Ставим выделение на любой элемент, чтобы было что копировать
        document.getElementById('treeSelectAll').click();
        await new Promise((r) => setTimeout(r, 400));
        document.querySelectorAll('.toast .toast-close').forEach((b) => b.click());
        document.getElementById('coordSelectionCopy').click();
        await new Promise((r) => setTimeout(r, 400));
        return {
            clip: await navigator.clipboard.readText(),
            toast: [...document.querySelectorAll('.toast .toast-text')].map((t) => t.textContent).join(' | ')
        };
    });
    // Ожидаем «широта, долгота» рядом с площадкой, а не плоские метры
    const pair = (copied.clip || '').split(',').map((s) => parseFloat(s.trim()));
    const looksLikeLatLon = pair.length === 2 &&
        Math.abs(pair[0] - SITE.lat) < 0.05 && Math.abs(pair[1] - SITE.lon) < 0.05;
    if (!looksLikeLatLon) {
        problems.push(`копирование координат отдало «${copied.clip}», ожидались широта/долгота около ${SITE.lat}, ${SITE.lon}`);
    }
    if (!/Яндекс/i.test(copied.toast)) problems.push('после копирования нет подсказки про вставку в Яндекс.Карты');
    console.log(`B2. копирование: «${copied.clip}» (площадка ${SITE.lat}, ${SITE.lon}) — ${looksLikeLatLon ? 'ок' : 'СБОЙ'}`);
    await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));

    // B3. Охват и детализация: «один квадрат» должен масштабироваться.
    const beforeCount = tileUrls.length;
    const coverage = await page.evaluate(async () => {
        document.getElementById('btnBaseMap').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('mapBuilderBind').click();
        await new Promise((r) => setTimeout(r, 300));
        const est = () => document.getElementById('baseMapEstimate').textContent;
        const radiusBefore = document.getElementById('baseMapRadius').value;
        document.getElementById('baseMapRadiusFit').click();
        const radiusFitted = document.getElementById('baseMapRadius').value;
        // Детализацию сравниваем на крупном охвате: на мелкой площадке зум
        // упирается в потолок провайдера и оба уровня дают одно и то же.
        const radiusEl = document.getElementById('baseMapRadius');
        radiusEl.value = '5000';
        radiusEl.dispatchEvent(new Event('input', { bubbles: true }));
        const estNormal = est();
        const sel = document.getElementById('baseMapDetail');
        sel.value = 'high';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const estHigh = est();
        document.getElementById('baseMapCancel').click();
        return { radiusBefore, radiusFitted, estNormal, estHigh };
    });
    const tilesOf = (text) => Number((text.match(/квадратов\s+(\d+)/) || [])[1] || 0);
    if (!(tilesOf(coverage.estHigh) > tilesOf(coverage.estNormal))) {
        problems.push(`высокая детализация не даёт больше квадратов: ${tilesOf(coverage.estNormal)} → ${tilesOf(coverage.estHigh)}`);
    }
    if (!Number.isFinite(parseFloat(coverage.radiusFitted)) || parseFloat(coverage.radiusFitted) < 50) {
        problems.push(`«Под габарит моделей» дал охват ${coverage.radiusFitted}`);
    }
    console.log(`B3. охват под модели: радиус ${coverage.radiusBefore} → ${coverage.radiusFitted} м; на 10 км квадратов обычная ${tilesOf(coverage.estNormal)} → высокая ${tilesOf(coverage.estHigh)}`);

    // B4. Драпировка: сетка должна густеть с охватом, иначе рельеф режется
    // крупными гранями — на километровой площадке шаг был 20 м.
    const drape = await page.evaluate(async () => {
        document.getElementById('btnBaseMap').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('mapBuilderBind').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('baseMapDrape').checked = true;
        document.getElementById('baseMapRadius').value = '800';
        document.getElementById('baseMapApply').click();
        for (let i = 0; i < 120 && document.getElementById('baseMapModal').classList.contains('show'); i++) {
            await new Promise((r) => setTimeout(r, 250));
        }
        const bm = window.BimLvaDebug.basemapLayer;
        return bm ? { uvCount: bm.uvCount, sizeX: bm.sizeX } : null;
    });
    if (!drape) {
        problems.push('подложка с натягиванием на рельеф не построилась');
    } else {
        // 1600 м при шаге ~4 м → сторона сетки 400 → ограничена потолком 320
        const side = Math.round(Math.sqrt(drape.uvCount)) - 1;
        if (side < 200) {
            problems.push(`сетка драпировки ${side}×${side} — шаг ${(drape.sizeX / side).toFixed(1)} м, рельеф будет резаться гранями`);
        }
        console.log(`B4. драпировка: сетка ${side}×${side}, шаг ${(drape.sizeX / side).toFixed(1)} м на охвате ${drape.sizeX.toFixed(0)} м`);
    }

    // C. Тайлы: запрошены и лимит соблюдён
    const zooms = [...new Set(tileUrls.map((u) => (u.match(/\/(\d+)\/\d+\/\d+/) || [])[1]).filter(Boolean))];
    if (!tileUrls.length) problems.push('ни один тайл не запрошен');
    // Считаем последнюю сборку: за прогон их несколько, накопительная сумма
    // ничего не говорит о бюджете
    const lastBuildTiles = tileUrls.length - beforeCount;
    if (lastBuildTiles > 520) problems.push(`за одну сборку запрошено ${lastBuildTiles} тайлов — бюджет детализации не соблюдается`);
    console.log(`C. тайлов за прогон ${tileUrls.length} (последняя сборка ${lastBuildTiles}), зум ${zooms.join(',')}`);

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

    // E. Рельеф с карты: формула высот + меш, который сверлит sampleTerrainZ
    const demFormula = await page.evaluate(() => ({
        terrarium: window.BimLvaDebug.decodeDemHeight('terrarium', 128, 60, 0, 255),
        mapbox: window.BimLvaDebug.decodeDemHeight('mapbox', 1, 136, 248, 255),
        nodata: window.BimLvaDebug.decodeDemHeight('terrarium', 128, 60, 0, 0)
    }));
    if (Math.abs(demFormula.terrarium - TERRARIUM_Z) > 1e-6) {
        problems.push(`Terrarium (128,60,0) → ${demFormula.terrarium}, ожидалось ${TERRARIUM_Z}`);
    }
    if (Math.abs(demFormula.mapbox - TERRARIUM_Z) > 0.05) {
        problems.push(`Terrain-RGB (1,136,248) → ${demFormula.mapbox}, ожидалось ${TERRARIUM_Z}`);
    }
    if (Number.isFinite(demFormula.nodata)) {
        problems.push(`прозрачный пиксель Terrarium дал ${demFormula.nodata}, ожидался NaN`);
    }
    console.log(`E0. формула: Terrarium ${demFormula.terrarium} м, Terrain-RGB ${demFormula.mapbox} м`);

    const rgbNeedTemplate = await page.evaluate(async () => {
        document.getElementById('btnBaseMap').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('mapBuilderBind').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('baseMapDemSource').value = 'terrainRgb';
        document.getElementById('baseMapDemTemplate').value = '';
        document.querySelectorAll('.toast .toast-close').forEach((b) => b.click());
        document.getElementById('baseMapDemApply').click();
        await new Promise((r) => setTimeout(r, 800));
        const toast = [...document.querySelectorAll('.toast .toast-text')].map((t) => t.textContent).join(' | ');
        document.getElementById('baseMapDemSource').value = 'terrarium';
        document.getElementById('baseMapDemSource').dispatchEvent(new Event('change', { bubbles: true }));
        return toast;
    });
    if (!/\{z\}|шаблон/i.test(rgbNeedTemplate)) {
        problems.push(`Terrain-RGB без шаблона: «${rgbNeedTemplate.slice(0, 160)}»`);
    }
    console.log(`E1. Terrain-RGB без ключа: ${/шаблон/i.test(rgbNeedTemplate) ? 'ошибка шаблона' : 'СБОЙ'}`);
    await page.evaluate(() => document.querySelectorAll('.toast .toast-close').forEach((b) => b.click()));

    const demBefore = demUrls.length;
    await page.evaluate(([lat, lon, radius]) => {
        document.getElementById('baseMapLat').value = String(lat);
        document.getElementById('baseMapLon').value = String(lon);
        document.getElementById('baseMapRadius').value = String(radius);
        document.getElementById('baseMapDemSource').value = 'terrarium';
        document.getElementById('baseMapDemApply').click();
    }, [SITE.lat, SITE.lon, RADIUS]);
    const demBuilt = await page
        .waitForFunction(() => window.BimLvaDebug?.mapTerrainLayer != null, { timeout: 90_000 })
        .then(() => true).catch(() => false);
    if (!demBuilt) {
        problems.push('рельеф с карты не построился');
    } else {
        const dem = await page.evaluate((offsetM) => {
            const layer = window.BimLvaDebug.mapTerrainLayer;
            const mb = window.BimLvaDebug.modelBounds[0];
            // Бить в стороне от коробок IFC: иначе луч первым поймает крышу, не DEM.
            const x = layer.centerX + offsetM;
            const y = layer.centerY;
            const z = window.BimLvaDebug.sampleTerrainZ(x, y, Number.NaN);
            return { layer, mb, sample: { x, y, z } };
        }, 600);
        if (!dem.layer.isMapTerrain) problems.push('меш рельефа без isMapTerrain');
        if (dem.layer.isGeoRaster) problems.push('меш рельефа помечен isGeoRaster — луч его не увидит');
        const sizeOk = Math.abs(dem.layer.sizeX - RADIUS * 2) < 2 && Math.abs(dem.layer.sizeY - RADIUS * 2) < 2;
        if (!sizeOk) {
            problems.push(`размер рельефа ${dem.layer.sizeX.toFixed(0)}×${dem.layer.sizeY.toFixed(0)} вместо ${RADIUS * 2}`);
        }
        const offset = Math.hypot(dem.layer.centerX - dem.mb.centerX, dem.layer.centerY - dem.mb.centerY);
        if (!(offset < 300)) problems.push(`рельеф съехал от модели на ${offset.toFixed(0)} м`);
        if (!Number.isFinite(dem.sample.z)) {
            problems.push(`sampleTerrainZ в стороне от модели не попал в DEM (${dem.sample.x.toFixed(1)}, ${dem.sample.y.toFixed(1)})`);
        } else {
            const dz = Math.abs(dem.sample.z - dem.layer.centerZ);
            if (!(dz < 2)) {
                problems.push(
                    `sampleTerrainZ дал ${dem.sample.z.toFixed(2)}, центр DEM ${dem.layer.centerZ.toFixed(2)} ` +
                    `(ожидалась высота Terrarium ${TERRARIUM_Z} м минус ноль сцены)`
                );
            }
        }
        if (demUrls.length <= demBefore) problems.push('ни один тайл Terrarium не запрошен');
        console.log(
            `E2. рельеф: ${dem.layer.sizeX.toFixed(0)}×${dem.layer.sizeY.toFixed(0)} м, ` +
            `смещение ${offset.toFixed(0)} м, z сцены ${dem.layer.centerZ.toFixed(2)}, ` +
            `sampleTerrainZ ${Number.isFinite(dem.sample.z) ? dem.sample.z.toFixed(2) : 'NaN'}, ` +
            `тайлов ${demUrls.length - demBefore}`
        );
    }

    const demRemoved = await page.evaluate(() => {
        document.getElementById('btnBaseMap').click();
        document.getElementById('mapBuilderBind').click();
        document.getElementById('baseMapDemRemove').click();
        document.getElementById('baseMapCancel').click();
        return window.BimLvaDebug.mapTerrainLayer == null;
    });
    if (!demRemoved) problems.push('рельеф с карты не убрался по кнопке');
    console.log(`E3. удаление рельефа: ${demRemoved ? 'ок' : 'СБОЙ'}`);

    // F. Убрать подложку
    const removed = await page.evaluate(() => {
        document.getElementById('baseMapRemove').click();
        return window.BimLvaDebug.basemapLayer == null;
    });
    if (!removed) problems.push('подложка не убралась по кнопке');
    console.log(`F. удаление подложки: ${removed ? 'ок' : 'СБОЙ'}`);

    // Дальше Terrarium нарочно ниже модели: без сдвига по Z сетка сядет
    // на высоте тайла (~10 м), а площадка IFC на 60 м — как у владельца
    // «отметка не та» (30 м с карты против 141 м в файле).
    const PNG_TERRARIUM_10 = pngRgba(128, 10, 0, 255);
    await page.unroute('**/elevation-tiles-prod/terrarium/**');
    await page.route('**/elevation-tiles-prod/terrarium/**', (route) => {
        demUrls.push(route.request().url());
        route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG_TERRARIUM_10 });
    });

    // M. Model Builder: рамка / контур, лимит 200 га, «Загрузить»
    const haAround = (site, sideM) => {
        const mLat = 111320;
        const mLon = 111320 * Math.cos((site.lat * Math.PI) / 180);
        const dLat = (sideM / 2) / mLat;
        const dLon = (sideM / 2) / mLon;
        return [
            { lat: site.lat - dLat, lon: site.lon - dLon },
            { lat: site.lat + dLat, lon: site.lon + dLon }
        ];
    };
    const mOk = await page.evaluate(async ([site, a, b]) => {
        document.getElementById('btnMapBuilder').click();
        await new Promise((r) => setTimeout(r, 200));
        window.BimLvaDebug.mapBuilderSetView(site.lat, site.lon, 14);
        window.BimLvaDebug.mapBuilderDrawRect(a, b);
        return window.BimLvaDebug.mapBuilderState;
    }, [SITE, ...haAround(SITE, 1000)]);
    if (!mOk.shown) problems.push('кнопка «Площадка с карты» не открыла глобус');
    if (!(mOk.areaHa > 90 && mOk.areaHa < 110)) {
        problems.push(`рамка 1×1 км дала ${mOk.areaHa?.toFixed?.(2)} га, ожидалось ~100`);
    }
    if (!mOk.loadEnabled) problems.push('«Загрузить» выкл на 100 га (лимит 200)');
    if (!mOk.placeLocked) {
        problems.push('при загруженной модели выбор «нули / мировые» не заблокирован');
    }
    console.log(`M1. рамка 1 км: ${mOk.areaHa?.toFixed?.(1)} га, Загрузить ${mOk.loadEnabled ? 'вкл' : 'выкл'}, координаты ${mOk.placeLocked ? 'по модели' : 'свободны'}`);

    const mOver = await page.evaluate(([a, b]) => {
        window.BimLvaDebug.mapBuilderDrawRect(a, b);
        return window.BimLvaDebug.mapBuilderState;
    }, haAround(SITE, 1600));
    if (!mOver.overLimit) problems.push(`рамка 1.6 км (${mOver.areaHa?.toFixed?.(1)} га) не помечена как сверх 200 га`);
    if (mOver.loadEnabled) problems.push('«Загрузить» не блокируется сверх 200 га');
    console.log(`M2. рамка 1.6 км: ${mOver.areaHa?.toFixed?.(1)} га, сверх лимита ${mOver.overLimit ? 'да' : 'НЕТ'}`);

    const mPoly = await page.evaluate((site) => {
        const mLat = 111320;
        const mLon = 111320 * Math.cos((site.lat * Math.PI) / 180);
        const pts = [
            { lat: site.lat, lon: site.lon },
            { lat: site.lat + 800 / mLat, lon: site.lon },
            { lat: site.lat, lon: site.lon + 800 / mLon }
        ];
        window.BimLvaDebug.mapBuilderDrawPolygon(pts);
        return window.BimLvaDebug.mapBuilderState;
    }, SITE);
    if (mPoly.type !== 'poly' || mPoly.points !== 3) {
        problems.push(`контур: type=${mPoly.type} points=${mPoly.points}`);
    }
    if (!(mPoly.areaHa > 28 && mPoly.areaHa < 36)) {
        problems.push(`треугольник 800×800 м дал ${mPoly.areaHa?.toFixed?.(2)} га, ожидалось ~32`);
    }
    if (!mPoly.loadEnabled) problems.push('контур ~32 га не даёт «Загрузить»');
    console.log(`M3. контур: ${mPoly.areaHa?.toFixed?.(2)} га, ${mPoly.points} вершин`);

    await page.evaluate(([a, b]) => {
        window.BimLvaDebug.mapBuilderSetPlace('world');
        window.BimLvaDebug.mapBuilderDrawRect(a, b);
    }, haAround(SITE, 800));
    await page.evaluate(() => document.getElementById('mapBuilderLoad').click());
    const mLoaded = await page
        .waitForFunction(
            () => window.BimLvaDebug?.basemapLayer != null && window.BimLvaDebug?.mapTerrainLayer != null,
            { timeout: 90_000 }
        )
        .then(() => true).catch(() => false);
    if (!mLoaded) {
        problems.push('«Загрузить» с глобуса не построило снимок и рельеф');
    } else {
        const layers = await page.evaluate(() => ({
            bm: window.BimLvaDebug.basemapLayer,
            dem: window.BimLvaDebug.mapTerrainLayer,
            builderClosed: !document.getElementById('mapBuilderModal').classList.contains('show')
        }));
        if (!layers.builderClosed) problems.push('окно глобуса не закрылось после «Загрузить»');
        if (!layers.dem?.isMapTerrain) problems.push('после «Загрузить» нет меша рельефа');
        if (layers.dem?.isGeoRaster) problems.push('рельеф после «Загрузить» помечен как картинка');
        const side = Math.min(layers.bm.sizeX, layers.bm.sizeY);
        if (!(side > 700 && side < 1400)) {
            problems.push(`охват после «Загрузить» ${layers.bm.sizeX.toFixed(0)}×${layers.bm.sizeY.toFixed(0)} м, ждали ~800–1130`);
        }
        const mapVsModel = Math.hypot(layers.bm.centerX - modelBounds.centerX, layers.bm.centerY - modelBounds.centerY);
        if (!(mapVsModel < 300)) {
            problems.push(
                `при модели режим «мировые» увёл карту на ${mapVsModel.toFixed(0)} м ` +
                `(должна сесть в координаты модели, не в ГК рамки)`
            );
        }
        console.log(
            `M4. Загрузить: подложка ${layers.bm.sizeX.toFixed(0)}×${layers.bm.sizeY.toFixed(0)} м, ` +
            `рельеф ${layers.dem.sizeX.toFixed(0)}×${layers.dem.sizeY.toFixed(0)} м`
        );
        const siteChrome = await page.evaluate(() => {
            const hint = document.getElementById('hint');
            return {
                hintDisplay: hint ? hint.style.display : '',
                treeText: document.getElementById('tree')?.innerText || '',
                mapSite: window.BimLvaDebug.mapSite
            };
        });
        if (siteChrome.hintDisplay !== 'none') {
            problems.push('после загрузки карты висит подсказка «добавьте модели»');
        }
        if (!/Площадка с карты/.test(siteChrome.treeText) || !/Рельеф/.test(siteChrome.treeText)) {
            problems.push(`в дереве нет рельефа с карты: «${siteChrome.treeText.slice(0, 240)}»`);
        }
        if (!siteChrome.mapSite?.hasTerrain || !siteChrome.mapSite?.hasBasemap) {
            problems.push(`map-site неполный: ${JSON.stringify(siteChrome.mapSite)}`);
        }
        console.log(
            `M4b. дерево: ${/Рельеф/.test(siteChrome.treeText) ? 'рельеф есть' : 'НЕТ'}, ` +
            `hint=${siteChrome.hintDisplay || 'visible'}`
        );
        const zFit = await page.evaluate(() => {
            const dem = window.BimLvaDebug.mapTerrainLayer;
            const mb = (window.BimLvaDebug.modelBounds || []).find((m) => m.format !== 'MAP')
                || window.BimLvaDebug.modelBounds[0];
            return {
                demZ: dem.centerZ,
                modelZ: mb.centerZ,
                zShift: dem.zShift,
                sample: window.BimLvaDebug.sampleTerrainZ(dem.centerX, dem.centerY, Number.NaN)
            };
        });
        if (!(zFit.zShift > 20)) {
            problems.push(
                `рельеф не совмещён с моделью: zShift=${zFit.zShift?.toFixed?.(1)} ` +
                `(Terrarium 10 м, модель ~60 м — ждали сдвиг ~50 м)`
            );
        }
        if (!(Math.abs(zFit.demZ - zFit.modelZ) < 8)) {
            problems.push(
                `после совмещения DEM z=${zFit.demZ?.toFixed?.(2)}, модель z=${zFit.modelZ?.toFixed?.(2)}`
            );
        }
        console.log(
            `M4c. отметка: zShift ${zFit.zShift?.toFixed?.(1)} м, ` +
            `DEM ${zFit.demZ?.toFixed?.(2)} / модель ${zFit.modelZ?.toFixed?.(2)}`
        );
    }

    /* F2. Подложка не должна проваливаться под рельеф.
     *
     * Драпировка лучами кладёт снимок на СВОЮ сетку (~4 м), а рельеф нарезан
     * своей (20 м): вершины совпадают, а между ними хорда срезает перелом
     * грани и уходит под землю — рельеф проступает пятнами и мерцает при
     * вращении (скриншот владельца, 2026-08-22).
     * ⚠️ На ГЛАДКОМ DEM это не воспроизводится вовсе: замерено 0 протыканий
     * при зазоре 0.045 м. Нужна короткая волна — реальный DEM неровен на шаге
     * собственной сетки. Поэтому здесь свой, «шершавый» тайл высот.
     * ⚠️ И мерить надо ЛУЧОМ по обеим поверхностям: арифметическая середина
     * ячейки на треугольнике не лежит и даёт 49.6% «протыканий» на заведомо
     * исправной геометрии. */
    await page.unroute('**/elevation-tiles-prod/terrarium/**');
    await page.route('**/elevation-tiles-prod/terrarium/**', (route) =>
        route.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: PNG_TERRARIUM_ROUGH }));
    await clearMapScene();
    const roughOk = await loadMapOnEmptyScene('zeros');
    if (!roughOk) {
        problems.push('карта на неровном рельефе не загрузилась');
    } else {
        const drape = await page.evaluate(() => window.BimLvaDebug.mapDrapeProbe(120));
        console.log(`F2. подложка на рельефе: точек ${drape.points}, провалов ${drape.pierced}`
            + ` (${drape.share}%), худший ${drape.worst} м, минимальный зазор ${drape.minGap} м`);
        if (!(drape.points > 1000)) {
            problems.push(`подложка и рельеф не пересеклись лучом (точек ${drape.points}) — проверка вхолостую`);
        }
        if (drape.pierced > 0) {
            problems.push(`рельеф проваливается сквозь подложку: ${drape.share}% точек, до ${drape.worst} м`);
        }
        if (!(drape.minGap > 0)) {
            problems.push(`подложка не выше рельефа (зазор ${drape.minGap} м)`);
        }
    }

    // G. Понятная ошибка, если тайлы не отдаются
    await page.route('**/tile.openstreetmap.org/**', (route) => route.abort());
    await page.evaluate(([lat, lon]) => {
        document.getElementById('btnBaseMap').click();
        document.getElementById('mapBuilderBind').click();
        document.getElementById('baseMapProvider').value = 'osm';
        document.getElementById('baseMapProvider').dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('baseMapLat').value = String(lat);
        document.getElementById('baseMapLon').value = String(lon);
        document.getElementById('baseMapApply').click();
    }, [SITE.lat, SITE.lon]);
    const errShown = await page
        .waitForFunction(
            () => [...document.querySelectorAll('.toast .toast-text')].some((t) => /тайл/i.test(t.textContent)),
            { timeout: 60_000 }
        )
        .then(() => true).catch(() => false);
    if (!errShown) problems.push('при недоступных тайлах нет понятного сообщения');
    console.log(`G. недоступные тайлы: сообщение ${errShown ? 'показано' : 'НЕТ'}`);
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
