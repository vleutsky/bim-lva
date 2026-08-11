/**
 * Диагностика IFC в личном кабинете. Проверяем разбор, а не сеть: подсовываем
 * синтетический IFC с заранее известными числами и сверяем отчёт.
 *
 * Отдельно проверяется склейка кусков: файл искусственно раздувается так, чтобы
 * он не влез в один 8-мегабайтный кусок, и точка с максимальными координатами
 * кладётся у самой границы — если carry сломать, габарит «потеряет» её.
 */
import { chromium } from 'playwright';
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

function check(ok, label, extra = '') {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? ' — ' + extra : ''}`);
    if (!ok) problems.push(label + (extra ? ' — ' + extra : ''));
}

// Габарит берём из настоящей задачи: площадка ПЗУ из Civil 3D.
const MIN = [54735.880, 33202.274, 1503.39];
const MAX = [56106.225, 34202.818, 1609.97];

function makeIfc(padPoints) {
    const head = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
        "FILE_NAME('site.ifc','2026-08-10T00:00:00',(''),(''),'','Civil 3D 2024','');",
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        "#1= IFCPROJECT('0aB',#2,'ПЗУ',$,$,$,$,(#9),#3);",
        "#4= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
        "#5= IFCSITE('0aC',#2,'Площадка',$,$,#7,$,$,.ELEMENT.,(55,45,0),(37,36,0),1500.,$,$);",
        '#6= IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#20,#21);',
        `#10= IFCCARTESIANPOINT((${MIN[0]},${MIN[1]},${MIN[2]}));`,
        '#11= IFCCARTESIANPOINT((0.,0.));'
    ];
    // Балласт, чтобы файл перевалил за один кусок чтения
    const pad = [];
    for (let i = 0; i < padPoints; i++) {
        pad.push(`#${1000 + i}= IFCCARTESIANPOINT((55000.,33500.,1550.));`);
    }
    const tail = [
        `#900000= IFCCARTESIANPOINT((${MAX[0]},${MAX[1]},${MAX[2]}));`,
        'ENDSEC;',
        'END-ISO-10303-21;'
    ];
    return [...head, ...pad, ...tail].join('\n');
}

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

try {
    await page.goto(`http://127.0.0.1:${port}/cabinet.html`, { waitUntil: 'domcontentloaded' });
    // Кабинет за логином — для разбора файла авторизация не нужна, открываем секцию
    await page.evaluate(() => {
        document.getElementById('cabMain')?.classList.remove('hidden');
        document.getElementById('cabGate')?.classList.add('hidden');
    });
    await page.waitForSelector('#ifcdDrop', { state: 'visible' });

    // ~9.5 МБ: больше одного 8-мегабайтного куска
    const ifc = makeIfc(220000);
    console.log(`\nФикстура: ${(ifc.length / 1024 / 1024).toFixed(1)} МБ, границ кусков ≥ 1`);

    await page.setInputFiles('#ifcdFile', {
        name: 'ПЗУ-тест.ifc',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(ifc, 'latin1')
    });

    await page.waitForFunction(
        () => document.getElementById('ifcdOut')?.textContent?.includes('Мировой габарит'),
        null,
        { timeout: 60000 }
    );
    const report = await page.textContent('#ifcdOut');

    console.log('');
    check(/Схема:\s+IFC4/.test(report), 'схема прочитана');
    check(/Единица:\s+metre/.test(report), 'единица длины прочитана');
    check(/Civil 3D 2024/.test(report), 'экспортёр виден в FILE_NAME');

    // Габарит: min из первой строки, max из последней — обе за границей куска друг от друга
    const gotMinX = new RegExp(`X \\(east\\)\\s*:\\s*${MIN[0].toFixed(3)}`).test(report);
    const gotMaxX = new RegExp(`\\u2026 ${MAX[0].toFixed(3)}`).test(report);
    const gotMaxY = new RegExp(`\\u2026 ${MAX[1].toFixed(3)}`).test(report);
    const gotMaxZ = new RegExp(`\\u2026 ${MAX[2].toFixed(3)}`).test(report);
    check(gotMinX, 'минимум X взят из начала файла');
    check(gotMaxX && gotMaxY && gotMaxZ, 'максимум взят из конца файла (склейка кусков цела)');

    check(/Точек 3D:\s*220 002/.test(report.replace(/\u00a0/g, ' ')), 'трёхмерные точки посчитаны');
    check(/двумерных/.test(report), 'двумерная точка в габарит не попала');
    check(/Булевых:\s*1/.test(report), 'булевы операции посчитаны');
    check(/IFCSITE/.test(report), 'IfcSite показан в геопривязке');

    // Кабинет прячет себя обратно, когда проверка входа закончилась без сессии,
    // — открываем ещё раз, иначе проверялся бы гейт, а не кнопка.
    await page.evaluate(() => document.getElementById('cabMain')?.classList.remove('hidden'));
    check(await page.isVisible('#ifcdCopy'), 'кнопка «Скопировать отчёт» появилась');

    // Второй файл — как выгрузка Renga/nanoCAD через ODA: миллиметры, геометрия
    // в IFCCARTESIANPOINTLIST3D, широта/долгота проставлены «Москвой по умолчанию».
    await page.evaluate(() => document.getElementById('ifcdReset').click());
    const ar = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        '#5= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
        "#310=IFCSITE('2pUZ',#20,'Default',$,$,#309,$,$,.ELEMENT.,(55,44,59,999999),(37,42,0,2746),1600150.,$,$);",
        '#400= IFCCARTESIANPOINT((55300050.,33820602.,1600150.));',
        '#401= IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(12000.,0.,0.),(12000.,7500.,3200.)));',
        'ENDSEC;',
        'END-ISO-10303-21;'
    ].join('\n');
    await page.setInputFiles('#ifcdFile', {
        name: 'АР-тест.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from(ar, 'latin1')
    });
    await page.waitForFunction(
        () => document.getElementById('ifcdOut')?.textContent?.includes('вершин сеток'),
        null, { timeout: 30000 }
    );
    const arReport = await page.textContent('#ifcdOut');
    check(/millimetre/.test(arReport), 'миллиметры распознаны');
    check(/Вершин сеток:\s*3/.test(arReport), 'вершины IFCCARTESIANPOINTLIST3D посчитаны');
    check(/12\.00/.test(arReport), 'локальный габарит сеток переведён в метры');
    check(/широта 55\.750000°, долгота 37\.700001°/.test(arReport), 'широта и долгота расшифрованы');
    check(/RefElevation\): 1600\.15 м/.test(arReport), 'отметка площадки переведена в метры');
    check(/это Москва по умолчанию/.test(arReport), 'заглушка координат экспортёра замечена');

    // Третий файл: цепочка размещения. IfcSite стоит в мировых координатах
    // (число снято с площадки — 55300.050/33820.602/1600.150), а единственный
    // элемент размещён с PlacementRelTo=$ — то есть НЕ унаследовал площадку.
    // Это ровно та поломка, которую разбор пришёл искать: элемент существует,
    // но его цепочка обрывается на первом же шаге, до site.
    await page.evaluate(() => document.getElementById('ifcdReset').click());
    const chainIfc = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        '#1=IFCCARTESIANPOINT((0.,0.,0.));',
        '#2=IFCDIRECTION((0.,0.,1.));',
        '#3=IFCDIRECTION((1.,0.,0.));',
        '#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);',
        '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
        "#10=IFCPROJECT('proj',$,'P',$,$,$,$,$,$);",
        '#20=IFCCARTESIANPOINT((55300.05,33820.602,1600.15));',
        '#21=IFCDIRECTION((0.97789,0.20913,0.));',
        '#22=IFCAXIS2PLACEMENT3D(#20,#2,#21);',
        '#11=IFCLOCALPLACEMENT($,#22);',
        "#12=IFCSITE('site',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);",
        '#13=IFCLOCALPLACEMENT(#11,#4);',
        "#14=IFCBUILDING('bld',$,'Building',$,$,#13,$,$,.ELEMENT.,$,$,$);",
        '#15=IFCLOCALPLACEMENT(#13,#4);',
        "#16=IFCBUILDINGSTOREY('storey',$,'Level0',$,$,#15,$,$,.ELEMENT.,0.);",
        // Продукт НЕ ссылается на #15 (storey) — PlacementRelTo=$, поэтому его
        // локальные координаты (10,5,2) остаются мировыми как есть.
        '#30=IFCCARTESIANPOINT((10.,5.,2.));',
        '#31=IFCAXIS2PLACEMENT3D(#30,$,$);',
        '#32=IFCLOCALPLACEMENT($,#31);',
        "#33=IFCBUILDINGELEMENTPROXY('broken',$,'BrokenBox',$,$,#32,$,$,$);",
        'ENDSEC;',
        'END-ISO-10303-21;'
    ].join('\n');
    await page.setInputFiles('#ifcdFile', {
        name: 'chain-тест.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from(chainIfc, 'latin1')
    });
    await page.waitForFunction(
        () => document.getElementById('ifcdOut')?.textContent?.includes('Мировой габарит') ||
            document.getElementById('ifcdOut')?.textContent?.includes('IFCCARTESIANPOINT не найдено'),
        null, { timeout: 30000 }
    );
    await page.evaluate(() => document.getElementById('cabMain')?.classList.remove('hidden'));
    const chainBtnEnabled = await page.evaluate(() => !document.getElementById('ifcdChain').disabled);
    check(chainBtnEnabled, 'кнопка «Цепочка размещения» включилась после разбора');
    await page.evaluate(() => document.getElementById('ifcdChain').click());
    await page.waitForFunction(
        () => document.getElementById('ifcdOut')?.textContent?.includes('Итог — мировая точка'),
        null, { timeout: 30000 }
    );
    const chainReport = await page.textContent('#ifcdOut');
    check(/=== Цепочка размещения/.test(chainReport), 'раздел цепочки появился в отчёте');
    check(/IfcSite #12/.test(chainReport), 'IfcSite найден по id');
    check(/55300\.050.*33820\.602.*1600\.150/s.test(chainReport), 'мировая точка IfcSite посчитана верно');
    // От заголовка «(типовой элемент)», а не от первого упоминания типа —
    // тот встречается раньше, в сводке «Чаще всего встречается».
    const productSection = chainReport.slice(chainReport.indexOf('типовой элемент'));
    check(/Уровней в цепочке:\s*1/.test(productSection), 'у оторванного элемента цепочка длиной 1 (не унаследовал site)');
    check(!/55300/.test(productSection), 'оторванный элемент НЕ показывает мировые координаты площадки');
    check(/10\.000, 5\.000, 2\.000/.test(productSection), 'локальные координаты оторванного элемента верны');

    // Четвёртый файл: находка с реального объекта. IfcSite и элемент стоят на
    // ИДЕНТИЧНЫХ (нулевых) размещениях — цепочка IfcLocalPlacement целиком в
    // нуле, — а мировой сдвиг лежит ОТДЕЛЬНО, в WorldCoordinateSystem контекста
    // представления. IfcMapConversion при этом в файле нет (как и в реальном).
    // Ровно так выглядел файл АР, когда его пропустили через эту диагностику.
    await page.evaluate(() => document.getElementById('ifcdReset').click());
    const wcsIfc = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_SCHEMA(('IFC4'));",
        'ENDSEC;',
        'DATA;',
        '#1=IFCCARTESIANPOINT((0.,0.,0.));',
        '#2=IFCDIRECTION((0.,0.,1.));',
        '#3=IFCDIRECTION((1.,0.,0.));',
        '#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);',
        '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
        // Мировой сдвиг — только здесь, вне цепочки IfcLocalPlacement.
        '#40=IFCCARTESIANPOINT((55300.05,33820.602,1600.15));',
        '#41=IFCDIRECTION((0.97789,0.20913,0.));',
        '#42=IFCAXIS2PLACEMENT3D(#40,#2,#41);',
        "#9=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#42,$);",
        "#10=IFCPROJECT('proj',$,'P',$,$,$,$,(#9),$);",
        // Site/Building/Storey — все на identity-размещении (0,0,0), как в файле АР.
        '#11=IFCLOCALPLACEMENT($,#4);',
        "#12=IFCSITE('site',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);",
        '#13=IFCLOCALPLACEMENT(#11,#4);',
        "#14=IFCBUILDING('bld',$,'Building',$,$,#13,$,$,.ELEMENT.,$,$,$);",
        '#15=IFCLOCALPLACEMENT(#13,#4);',
        "#16=IFCBUILDINGSTOREY('storey',$,'Level0',$,$,#15,$,$,.ELEMENT.,0.);",
        'ENDSEC;',
        'END-ISO-10303-21;'
    ].join('\n');
    await page.setInputFiles('#ifcdFile', {
        name: 'wcs-тест.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from(wcsIfc, 'latin1')
    });
    await page.waitForFunction(
        () => document.getElementById('ifcdOut')?.textContent?.includes('Мировой габарит'),
        null, { timeout: 30000 }
    );
    await page.evaluate(() => document.getElementById('cabMain')?.classList.remove('hidden'));
    await page.evaluate(() => document.getElementById('ifcdChain').click());
    await page.waitForFunction(
        () => document.getElementById('ifcdOut')?.textContent?.includes('WorldCoordinateSystem'),
        null, { timeout: 30000 }
    );
    const wcsReport = await page.textContent('#ifcdOut');
    const siteWcsSection = wcsReport.slice(wcsReport.indexOf('--- IfcSite'));
    check(/Уровней в цепочке:\s*1/.test(siteWcsSection), 'у IfcSite цепочка размещения короткая (identity)');
    check(/локально \(0\.000, 0\.000, 0\.000\)/.test(siteWcsSection), 'IfcSite действительно на нулевом размещении, а не «не нашли»');
    check(/точка \(55300\.050, 33820\.602, 1600\.150\)/.test(wcsReport), 'WorldCoordinateSystem найден и посчитан верно');
    check(/ЭТО МИРОВОЙ СДВИГ ВНЕ ЦЕПОЧКИ РАЗМЕЩЕНИЯ/.test(wcsReport), 'предупреждение о сдвиге вне цепочки выведено');
    // Не 12.06 — это округлённое число С ОБЪЕКТА, а не то, что даёт мой
    // приблизительный (0.97789, 0.20913) вектор. Считаю честно, как и код.
    const wantDeg = (Math.atan2(0.20913, 0.97789) * 180 / Math.PI).toFixed(3);
    check(wcsReport.includes(`поворот ≈ ${wantDeg}°`), 'поворот WorldCoordinateSystem посчитан верно');

    const copied = await page.evaluate(async () => {
        document.getElementById('ifcdReset').click();
        const o = document.getElementById('ifcdOut');
        return { outHidden: o.hidden, actionsHidden: document.getElementById('ifcdActions').hidden };
    });
    check(copied.outHidden && copied.actionsHidden, '«Другой файл» убирает прошлый отчёт');
} catch (error) {
    problems.push('исключение: ' + (error?.message || error));
} finally {
    await browser.close();
    server.close();
}

console.log('');
if (problems.length) {
    console.error(`Проблемы (${problems.length}):`);
    problems.forEach((p) => console.error('  · ' + p));
    process.exit(1);
}
console.log('OK — отчёт по IFC собирается верно.');
