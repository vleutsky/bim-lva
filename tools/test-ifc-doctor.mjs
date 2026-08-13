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
    // Обрезаем и снизу: ниже идёт «Пятно модели», где мировые координаты
    // площадки печатаются законно, и проверка «элемент их НЕ показывает»
    // цеплялась бы за чужую секцию.
    const productSection = chainReport.slice(
        chainReport.indexOf('типовой элемент'),
        chainReport.indexOf('Пятно модели')
    );
    check(/Уровней в цепочке:\s*1/.test(productSection), 'у оторванного элемента цепочка длиной 1 (не унаследовал site)');
    check(!/55300/.test(productSection), 'оторванный элемент НЕ показывает мировые координаты площадки');
    check(/10\.000, 5\.000, 2\.000/.test(productSection), 'локальные координаты оторванного элемента верны');

    // Поворот в цепочке раньше НЕ печатался вовсе: базис считался и молча
    // выбрасывался. Из-за этого «модель повёрнута не туда» по отчёту разобрать
    // было нельзя в принципе — сдвиги видно, углы нет. RefDirection у site тут
    // (0.97789, 0.20913) — это ровно 12.06°.
    const siteSection = chainReport.slice(
        chainReport.indexOf('IfcSite #12'),
        chainReport.indexOf('типовой элемент')
    );
    // Ожидание считаем из САМОГО вектора фикстуры, а не пишем числом: 12.06° —
    // это угол TrueNorth реального файла АР, а округлённый вектор фикстуры даёт
    // 12.071°, и захардкоженное число уже один раз соврало про поломку.
    const siteRefDir = [0.97789, 0.20913];
    const wantHeading = Math.atan2(siteRefDir[1], siteRefDir[0]) * 180 / Math.PI;
    const siteHeading = /Итог — поворот цепочки вокруг Z:\s*(-?[\d.]+)°/.exec(siteSection);
    check(siteHeading && Math.abs(Number(siteHeading[1]) - wantHeading) < 0.001,
        `поворот цепочки IfcSite посчитан и напечатан ` +
        `(${siteHeading ? siteHeading[1] : 'СТРОКИ НЕТ'}°, ждали ${wantHeading.toFixed(3)})`);
    check(siteSection.includes(`поворот ${wantHeading.toFixed(3)}°`),
        'поворот виден и на самом уровне, а не только в итоге');
    // «$ в файле» и «ссылка не нашлась» — разные вещи; тихо равнять их к «0°»
    // это та же ошибка, что уже правили для WorldCoordinateSystem.
    check(/поворот не задан \(\$\)/.test(productSection),
        'у элемента без Axis/RefDirection честно написано «не задан», а не «0°»');

    // Файл в духе Tekla: пространственная структура НЕ повёрнута, а сам элемент
    // развёрнут своим размещением (Axis = (1,0,0)) — так стоит любая вертикальная
    // пластина. Первая версия проверки складывала это с цепочкой и кричала
    // «модель наклонена» на каждой нормальной пластине. Тревога должна молчать.
    await page.evaluate(() => document.getElementById('ifcdReset').click());
    const plateIfc = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_SCHEMA(('IFC2X3'));",
        'ENDSEC;',
        'DATA;',
        '#1=IFCCARTESIANPOINT((0.,0.,0.));',
        '#2=IFCDIRECTION((0.,0.,1.));',
        '#3=IFCDIRECTION((1.,0.,0.));',
        '#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);',
        '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
        "#10=IFCPROJECT('proj',$,'P',$,$,$,$,$,$);",
        '#11=IFCLOCALPLACEMENT($,#4);',
        "#12=IFCSITE('site',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);",
        '#13=IFCLOCALPLACEMENT(#11,#4);',
        "#14=IFCBUILDING('bld',$,'Building',$,$,#13,$,$,.ELEMENT.,$,$,$);",
        '#15=IFCLOCALPLACEMENT(#13,#4);',
        "#16=IFCBUILDINGSTOREY('storey',$,'Level0',$,$,#15,$,$,.ELEMENT.,0.);",
        // Пластина стоит вертикально: её локальная Z смотрит вдоль мирового X.
        '#30=IFCCARTESIANPOINT((3.,4.,5.));',
        '#31=IFCDIRECTION((1.,0.,0.));',
        '#32=IFCAXIS2PLACEMENT3D(#30,#31,$);',
        '#33=IFCLOCALPLACEMENT(#15,#32);',
        "#34=IFCPLATE('plate',$,'Гусок',$,$,#33,$,$);",
        'ENDSEC;',
        'END-ISO-10303-21;'
    ].join('\n');
    await page.setInputFiles('#ifcdFile', {
        name: 'plate-tekla.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from(plateIfc, 'latin1')
    });
    await page.waitForFunction(
        () => document.getElementById('ifcdOut')?.textContent?.includes('Мировой габарит'),
        null, { timeout: 30000 }
    );
    await page.evaluate(() => document.getElementById('cabMain')?.classList.remove('hidden'));
    await page.evaluate(() => document.getElementById('ifcdChain').click());
    await page.waitForFunction(
        () => document.getElementById('ifcdOut')?.textContent?.includes('Итог — мировая точка'),
        null, { timeout: 30000 }
    );
    const plateReport = await page.textContent('#ifcdOut');
    const plateSection = plateReport.slice(
        plateReport.indexOf('типовой элемент'),
        plateReport.indexOf('Пятно модели')
    );
    check(/Итог — поворот структуры над элементом вокруг Z:\s*0\.000°/.test(plateSection),
        'структура над пластиной не повёрнута — 0°');
    check(!/⚠/.test(plateSection),
        'вертикальная пластина НЕ поднимает тревогу «модель наклонена» (это была ложная тревога)');
    check(/Собственный разворот элемента: 90\.000° вокруг Z, ось Z под 90\.000° к вертикали/.test(plateSection),
        'собственный разворот пластины показан отдельно и без тревоги');

    // Пятно по точкам вставки. По одной пластине разворот модели не виден —
    // они и должны смотреть в разные стороны; видно его по пропорциям пятна.
    // Здесь размещения стоят в (0,0,0) и (3,4,5) → размеры ровно 3 × 4 × 5.
    check(/Размещений учтено: 4/.test(plateReport),
        'учтены все цепочки размещения, а не только у типового элемента');
    check(/X \(east\): 0\.000 … 3\.000 м   \(размер 3\.000 м\)/.test(plateReport),
        'габарит точек вставки по X посчитан');
    check(/Y \(north\): 0\.000 … 4\.000 м   \(размер 4\.000 м\)/.test(plateReport),
        'габарит точек вставки по Y посчитан');
    check(/В плане длиннее по Y \(north\), отношение сторон 1\.33 : 1/.test(plateReport),
        'пропорции пятна названы — по ним и сравнивают два файла на разворот');

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

    // Пятый файл: RefDirection у WorldCoordinateSystem = $ (поворота там нет),
    // а проектный разворот лежит в TrueNorth контекста — так тоже бывает у
    // ODA-экспортёров, и раньше обе ветки молчали одинаково что при «$», что
    // при пробеле разбора — нечестно, не разобрать, что перед нами.
    await page.evaluate(() => document.getElementById('ifcdReset').click());
    const trueNorthIfc = [
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
        // WorldCoordinateSystem: сдвиг есть, а RefDirection — $ (не задан).
        '#40=IFCCARTESIANPOINT((55300.05,33820.602,1600.15));',
        '#42=IFCAXIS2PLACEMENT3D(#40,$,$);',
        // TrueNorth — отдельная Direction, не привязанная к WorldCoordinateSystem.
        '#43=IFCDIRECTION((0.20913,0.97789,0.));',
        "#9=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#42,#43);",
        "#10=IFCPROJECT('proj',$,'P',$,$,$,$,(#9),$);",
        '#11=IFCLOCALPLACEMENT($,#4);',
        "#12=IFCSITE('site',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);",
        'ENDSEC;',
        'END-ISO-10303-21;'
    ].join('\n');
    await page.setInputFiles('#ifcdFile', {
        name: 'true-north-тест.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from(trueNorthIfc, 'latin1')
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
    const tnReport = await page.textContent('#ifcdOut');
    check(
        tnReport.includes('RefDirection = $ — так в файле, поворот не задан (0°).'),
        'RefDirection = $ у WorldCoordinateSystem — честно показан 0°, а не молчание'
    );
    const wantTnDeg = (Math.atan2(0.20913, 0.97789) * 180 / Math.PI).toFixed(3);
    check(tnReport.includes(`истинный север повёрнут от оси Y на ≈ ${wantTnDeg}°`), 'TrueNorth прочитан и посчитан верно');

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
