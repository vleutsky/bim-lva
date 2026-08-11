/*
 * Диагностика IFC для личного кабинета BIM.LVA.
 *
 * Читает файл потоком через File.slice(), поэтому 200-мегабайтный рельеф не кладёт
 * вкладку: в память попадает по одному куску. Ничего никуда не отправляется —
 * разбор целиком в браузере.
 *
 * Что достаём и зачем:
 *   схема / экспортёр  — web-ifc по-разному ведёт себя на IFC2X3 и IFC4;
 *   единицы длины      — миллиметры против метров, классика разъехавшейся сводки;
 *   мировой габарит     — сверяется с «Свойства поверхности → Статистика» в Civil 3D
 *                        и отвечает на вопрос «файл привёз свои координаты или нет»;
 *   геопривязка         — IfcMapConversion / IfcSite, откуда берётся ноль;
 *   булевы операции     — их количество решает, придётся ли открывать файл со
 *                        сбросом координат в ноль (COORDINATE_TO_ORIGIN).
 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const drop = $('ifcdDrop');
    const input = $('ifcdFile');
    if (!drop || !input) return;

    const bar = $('ifcdBar');
    const barFill = bar ? bar.querySelector('i') : null;
    const out = $('ifcdOut');
    const actions = $('ifcdActions');
    const btnChain = $('ifcdChain');

    const CHUNK = 8 * 1024 * 1024;
    // Заголовок и привязка — сущностей мало, храним целиком; координаты — только счёт.
    const KEEP_WHOLE = new Set([
        'IFCSITE',
        'IFCMAPCONVERSION',
        'IFCPROJECTEDCRS',
        'IFCSIUNIT',
        'IFCCONVERSIONBASEDUNIT',
        'IFCGEOMETRICREPRESENTATIONCONTEXT'
    ]);
    const KEEP_LIMIT = 6;
    const BOOLEAN_TYPES = new Set([
        'IFCBOOLEANRESULT',
        'IFCBOOLEANCLIPPINGRESULT'
    ]);

    let busy = false;
    let lastFile = null;
    let lastUnitScale = 1;

    function setProgress(frac) {
        if (!bar || !barFill) return;
        bar.hidden = false;
        barFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    }

    function show(text) {
        if (!out) return;
        out.hidden = false;
        out.textContent = text;
    }

    /** Разбор одного куска текста. Вызывающий гарантирует, что кусок кончается на ';'. */
    function scanChunk(text, acc) {
        const entity = /#\d+\s*=\s*([A-Z0-9_]+)/g;
        let m;
        while ((m = entity.exec(text)) !== null) {
            const type = m[1];
            acc.entities++;
            acc.hist.set(type, (acc.hist.get(type) || 0) + 1);
            if (BOOLEAN_TYPES.has(type)) acc.booleans++;

            // IFC4-тесселяция: вершины лежат списком и почти всегда в ЛОКАЛЬНЫХ
            // координатах объекта — в мировой габарит их мешать нельзя, но и
            // молчать о них нельзя, иначе у Renga/nanoCAD «точек 3D» почти нет.
            if (type === 'IFCCARTESIANPOINTLIST3D') {
                const end = text.indexOf(';', m.index);
                const body = text.slice(m.index, end === -1 ? m.index + 400000 : end);
                const tri = /\(\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*,\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*,\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*\)/g;
                let t;
                while ((t = tri.exec(body)) !== null) {
                    const v = [Number(t[1]), Number(t[2]), Number(t[3])];
                    if (v.some((n) => !Number.isFinite(n))) continue;
                    acc.meshPoints++;
                    for (let i = 0; i < 3; i++) {
                        if (v[i] < acc.meshMin[i]) acc.meshMin[i] = v[i];
                        if (v[i] > acc.meshMax[i]) acc.meshMax[i] = v[i];
                    }
                }
                continue;
            }

            if (type === 'IFCCARTESIANPOINT') {
                // ждём «((x,y,z))» сразу за именем сущности
                const head = text.slice(entity.lastIndex, entity.lastIndex + 160);
                const coords = /^\s*\(\s*\(([^)]*)\)/.exec(head);
                if (!coords) continue;
                const nums = coords[1].split(',');
                if (nums.length < 3) { acc.points2d++; continue; }
                const x = Number(nums[0]);
                const y = Number(nums[1]);
                const z = Number(nums[2]);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                acc.points++;
                if (x < acc.min[0]) acc.min[0] = x;
                if (y < acc.min[1]) acc.min[1] = y;
                if (z < acc.min[2]) acc.min[2] = z;
                if (x > acc.max[0]) acc.max[0] = x;
                if (y > acc.max[1]) acc.max[1] = y;
                if (z > acc.max[2]) acc.max[2] = z;
                continue;
            }

            if (KEEP_WHOLE.has(type)) {
                const kept = acc.kept.get(type) || [];
                if (kept.length < KEEP_LIMIT) {
                    const end = text.indexOf(';', m.index);
                    kept.push(text.slice(m.index, end === -1 ? m.index + 300 : end + 1).trim());
                    acc.kept.set(type, kept);
                }
            }
        }

        // Шапка STEP: она вне DATA и под «#N=» не попадает
        if (!acc.header.schema) {
            const s = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text);
            if (s) acc.header.schema = s[1];
        }
        if (!acc.header.fileName) {
            const f = /FILE_NAME\s*\(([\s\S]{0,900}?)\)\s*;/i.exec(text);
            if (f) acc.header.fileName = f[1].replace(/\s+/g, ' ').trim();
        }
    }

    /** Единица длины из собранных IFCSIUNIT (метры на единицу файла). */
    function lengthUnitOf(acc) {
        const PREFIX = {
            KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: .1,
            CENTI: .01, MILLI: 1e-3, MICRO: 1e-6
        };
        for (const line of (acc.kept.get('IFCSIUNIT') || [])) {
            if (!/\.LENGTHUNIT\./i.test(line)) continue;
            const p = /\.(KILO|HECTO|DECA|DECI|CENTI|MILLI|MICRO)\./i.exec(line);
            const scale = p ? PREFIX[p[1].toUpperCase()] : 1;
            return { scale, label: p ? `${p[1].toLowerCase()}metre` : 'metre' };
        }
        for (const line of (acc.kept.get('IFCCONVERSIONBASEDUNIT') || [])) {
            if (!/\.LENGTHUNIT\./i.test(line)) continue;
            const name = /'([^']+)'/.exec(line);
            return { scale: null, label: name ? name[1] : 'conversion-based' };
        }
        return { scale: 1, label: 'не найдена, считаю метрами' };
    }

    /** (град, мин, сек, миллионные) из IfcSite → градусы. */
    function dmsToDeg(parts) {
        if (!parts || parts.length < 3) return null;
        const [d, m, s] = parts;
        const frac = parts.length > 3 ? parts[3] / 1e6 : 0;
        const sign = d < 0 ? -1 : 1;
        return sign * (Math.abs(d) + m / 60 + (s + frac) / 3600);
    }

    /** Человеческие пояснения к строкам геопривязки. */
    function geoNotes(acc, unitScale) {
        const notes = [];
        for (const line of (acc.kept.get('IFCSITE') || [])) {
            const tuples = [...line.matchAll(/\(\s*(-?\d+(?:\s*,\s*-?\d+){2,3})\s*\)/g)]
                .map((m) => m[1].split(',').map((v) => Number(v.trim())));
            const lat = dmsToDeg(tuples[0]);
            const lon = dmsToDeg(tuples[1]);
            if (lat === null || lon === null) continue;
            if (!lat && !lon) {
                notes.push('  IfcSite: широта и долгота нулевые — привязки к карте в файле нет.');
                continue;
            }
            notes.push(`  IfcSite: широта ${lat.toFixed(6)}°, долгота ${lon.toFixed(6)}°`);
            const elev = /,\s*(-?[\d.]+)\s*,\s*\$\s*,\s*\$\s*\)/.exec(line);
            if (elev) {
                const m = Number(elev[1]) * (unitScale || 1);
                notes.push(`  Отметка площадки (RefElevation): ${m.toFixed(2)} м`);
                // Москва на 1600 м не бывает: значит широта/долгота — заглушка экспортёра
                if (Math.abs(lat - 55.75) < 0.02 && Math.abs(lon - 37.7) < 0.02 && Math.abs(m - 150) > 200) {
                    notes.push('  ВНИМАНИЕ: 55.75/37.70 — это Москва по умолчанию, а отметка ей не соответствует.');
                    notes.push('  Широту/долготу экспортёр проставил «как есть», для подложки они не годятся.');
                }
            }
        }
        for (const line of (acc.kept.get('IFCMAPCONVERSION') || [])) {
            const nums = [...line.matchAll(/,\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/g)].map((m) => Number(m[1]));
            if (nums.length >= 6) {
                const [e, n, h, ax, ay, scale] = nums.slice(-6);
                notes.push(
                    `  IfcMapConversion: E ${e}, N ${n}, H ${h}, ось X (${ax}, ${ay}), масштаб ${scale}`
                );
                if (!scale) {
                    notes.push('  ВНИМАНИЕ: масштаб 0 — привязка нерабочая (всё, что её применит, схлопнется в точку).');
                }
                if (!ax && !ay) {
                    notes.push('  ВНИМАНИЕ: направление оси X нулевое — поворот на север не задан.');
                }
                if (!e && !n && !h) {
                    notes.push('  Сдвиг нулевой: координаты живут прямо в геометрии, а не в привязке.');
                }
            }
        }
        return notes;
    }

    function buildReport(file, acc, ms) {
        const L = [];
        const unit = lengthUnitOf(acc);
        const num = (v) => v.toLocaleString('ru-RU');
        const fixed = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : '—';

        L.push('=== BIM.LVA · диагностика IFC ===');
        L.push(`Файл:      ${file.name}`);
        L.push(`Размер:    ${(file.size / 1024 / 1024).toFixed(1)} МБ`);
        L.push(`Разбор:    ${(ms / 1000).toFixed(1)} с`);
        L.push(`Схема:     ${acc.header.schema || 'не найдена'}`);
        if (acc.header.fileName) L.push(`FILE_NAME: ${acc.header.fileName.slice(0, 400)}`);
        L.push(`Единица:   ${unit.label}${unit.scale && unit.scale !== 1 ? ` (×${unit.scale} к метру)` : ''}`);
        L.push(`Сущностей: ${num(acc.entities)}`);
        L.push(`Точек 3D:  ${num(acc.points)}${acc.points2d ? ` (+ ${num(acc.points2d)} двумерных — в габарит не идут)` : ''}`);
        if (acc.meshPoints) L.push(`Вершин сеток: ${num(acc.meshPoints)} (IFC4-тесселяция)`);
        L.push(`Булевых:   ${num(acc.booleans)}${acc.booleans >= 8 ? '  ← плотная CSG, возможен сброс координат при открытии' : ''}`);
        L.push('');

        if (acc.points) {
            const k = unit.scale || 1;
            const axis = ['X (east) ', 'Y (north)', 'Z (высота)'];
            L.push('--- Мировой габарит ---');
            L.push('(в единицах файла; в скобках — в метрах, если единица известна)');
            for (let i = 0; i < 3; i++) {
                const lo = acc.min[i];
                const hi = acc.max[i];
                const inM = unit.scale ? `   → ${fixed(lo * k)} … ${fixed(hi * k)} м` : '';
                L.push(`  ${axis[i]}: ${fixed(lo, 3)} … ${fixed(hi, 3)}${inM}`);
            }
            L.push('');
            L.push('Сверьте с Civil 3D: «Свойства поверхности → Статистика».');
            L.push('В габарит попадают и точки локальных систем (вставки, направления),');
            L.push('поэтому минимум может падать в 0 — ориентируйтесь на максимум.');
            L.push('');
        }

        if (acc.meshPoints) {
            const k = unit.scale || 1;
            const axis = ['X', 'Y', 'Z'];
            L.push('--- Габарит вершин сеток ---');
            L.push('Обычно это ЛОКАЛЬНЫЕ координаты объектов, а мировое положение');
            L.push('задаётся точками вставки выше. Если здесь геодезические числа —');
            L.push('значит экспортёр запек мировые координаты в саму геометрию.');
            for (let i = 0; i < 3; i++) {
                const lo = acc.meshMin[i];
                const hi = acc.meshMax[i];
                const inM = unit.scale ? `   → ${fixed(lo * k)} … ${fixed(hi * k)} м` : '';
                L.push(`  ${axis[i]}: ${fixed(lo, 3)} … ${fixed(hi, 3)}${inM}`);
            }
            L.push('');
        }

        const geo = [];
        for (const type of ['IFCMAPCONVERSION', 'IFCPROJECTEDCRS', 'IFCSITE']) {
            (acc.kept.get(type) || []).forEach(line => geo.push('  ' + line.slice(0, 300)));
        }
        L.push('--- Геопривязка ---');
        const decoded = geoNotes(acc, unit.scale);
        if (decoded.length) {
            decoded.forEach((n) => L.push(n));
            L.push('');
        }
        L.push(geo.length ? geo.join('\n') : '  IfcMapConversion / IfcProjectedCrs не найдены — привязки в файле нет,');
        if (!geo.length) L.push('  координаты просто лежат в геометрии (для сводки этого достаточно).');
        L.push('');

        const top = [...acc.hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
        L.push('--- Чаще всего встречается ---');
        top.forEach(([type, n]) => L.push(`  ${String(n).padStart(9)}  ${type}`));

        return L.join('\n');
    }

    /* --- Цепочка размещения (IfcLocalPlacement) ------------------------------
     * «Мировой габарит» и «Диагностика» показывают, ЧТО лежит в файле, но не
     * ГДЕ именно теряется мировая привязка, если вьювер сажает файл в свой
     * центр. Здесь — второй, отдельный проход по файлу: строится индекс всех
     * IfcLocalPlacement / IfcAxis2Placement3D / IfcCartesianPoint / IfcDirection,
     * а затем для IfcSite и для одного типового элемента цепочка
     * PlacementRelTo проходится до корня с накоплением мировых координат на
     * каждом шаге. Если у элемента цепочка обрывается раньше site (пустой
     * PlacementRelTo) или просто не доходит до тех же больших чисел — вот он,
     * разрыв, и видно, на каком уровне.
     *
     * Отдельный проход, а не совмещённый с основным: индекс из всех точек и
     * направлений файла — это может быть сотни тысяч записей, и держать его
     * при каждом обычном разборе незачем.
     */
    const PLACEMENT_TYPES = new Set([
        'IFCLOCALPLACEMENT', 'IFCAXIS2PLACEMENT3D', 'IFCCARTESIANPOINT', 'IFCDIRECTION'
    ]);
    // Любой IfcProduct: GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement, Representation — ObjectPlacement всегда 6-й параметр
    // (индекс 5), это фиксировано схемой IFC4 и не зависит от подтипа.
    const PRODUCT_TYPE_RE = new RegExp(
        '^IFC(WALL|WALLSTANDARDCASE|SLAB|COLUMN|BEAM|COVERING|FOOTING|MEMBER|PLATE|' +
        'RAILING|ROOF|STAIR|STAIRFLIGHT|RAMP|RAMPFLIGHT|DOOR|WINDOW|' +
        'BUILDINGELEMENTPROXY|BUILDINGELEMENTPART|FURNISHINGELEMENT|' +
        'FLOWSEGMENT|FLOWFITTING|FLOWTERMINAL|FLOWCONTROLLER|DISTRIBUTIONELEMENT|' +
        'PIPESEGMENT|PIPEFITTING|DUCTSEGMENT|DUCTFITTING|' +
        'CABLECARRIERSEGMENT|CABLESEGMENT|SPACE|CURTAINWALL|CHIMNEY|PILE)$'
    );

    /** Текст между парной парой скобок начиная с позиции '(' — глубина считается посимвольно. */
    function extractParen(text, parenStart) {
        let depth = 0;
        for (let i = parenStart; i < text.length; i++) {
            const c = text[i];
            if (c === '(') depth++;
            else if (c === ')') {
                depth--;
                if (depth === 0) return text.slice(parenStart + 1, i);
            }
        }
        return null;
    }

    /** Разбор списка параметров STEP-сущности по запятым верхнего уровня. */
    function splitTopLevelArgs(s) {
        const out = [];
        let depth = 0;
        let inStr = false;
        let cur = '';
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
                cur += c;
                if (c === "'") {
                    if (s[i + 1] === "'") cur += s[++i];   // '' — экранированная кавычка внутри строки
                    else inStr = false;
                }
                continue;
            }
            if (c === "'") { inStr = true; cur += c; continue; }
            if (c === '(') { depth++; cur += c; continue; }
            if (c === ')') { depth--; cur += c; continue; }
            if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
            cur += c;
        }
        out.push(cur);
        return out.map((x) => x.trim());
    }

    function refId(tok) {
        if (!tok) return null;
        const m = /^#(\d+)$/.exec(tok.trim());
        return m ? Number(m[1]) : null;
    }

    function parseVec(tok) {
        if (!tok) return null;
        const inner = tok.trim().replace(/^\(/, '').replace(/\)$/, '');
        const parts = inner.split(',').map((s) => Number(s.trim()));
        return parts.every(Number.isFinite) && parts.length ? parts : null;
    }

    function scanPlacementChunk(text, idx) {
        const entity = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/g;
        let m;
        while ((m = entity.exec(text)) !== null) {
            const id = Number(m[1]);
            const type = m[2];
            const parenStart = entity.lastIndex - 1;

            if (PLACEMENT_TYPES.has(type)) {
                const inner = extractParen(text, parenStart);
                if (inner == null) continue;
                const args = splitTopLevelArgs(inner);
                if (type === 'IFCLOCALPLACEMENT') {
                    idx.localPlacements.set(id, { relTo: refId(args[0]), rel: refId(args[1]) });
                } else if (type === 'IFCAXIS2PLACEMENT3D') {
                    idx.axis3d.set(id, { loc: refId(args[0]), axis: refId(args[1]), refDir: refId(args[2]) });
                } else if (type === 'IFCCARTESIANPOINT') {
                    idx.points.set(id, parseVec(args[0]));
                } else if (type === 'IFCDIRECTION') {
                    idx.dirs.set(id, parseVec(args[0]));
                }
                continue;
            }
            if (!idx.site && type === 'IFCSITE') {
                const inner = extractParen(text, parenStart);
                if (inner != null) {
                    const args = splitTopLevelArgs(inner);
                    idx.site = { id, placementRef: refId(args[5]) };
                }
                continue;
            }
            // Точный тип, не IFCGEOMETRICREPRESENTATIONSUBCONTEXT — у него другой
            // порядок атрибутов (свой WorldCoordinateSystem не задаёт, наследует).
            if (!idx.context && type === 'IFCGEOMETRICREPRESENTATIONCONTEXT') {
                const inner = extractParen(text, parenStart);
                if (inner != null) {
                    const args = splitTopLevelArgs(inner);
                    idx.context = { id, wcs: refId(args[4]), trueNorth: refId(args[5]) };
                }
                continue;
            }
            if (!idx.product && PRODUCT_TYPE_RE.test(type)) {
                const inner = extractParen(text, parenStart);
                if (inner != null) {
                    const args = splitTopLevelArgs(inner);
                    const ref = refId(args[5]);
                    if (ref != null) idx.product = { id, type, placementRef: ref };
                }
            }
        }
    }

    const V3_ZERO = [0, 0, 0];
    const len3 = (v) => Math.hypot(v[0], v[1], v[2]);
    const norm3 = (v) => { const l = len3(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross3 = (a, b) => [
        a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]
    ];

    /** Ортонормированный базис из Axis (Z) и RefDirection (X), как в IfcAxis2Placement3D. */
    function buildBasis(axis, refDir) {
        const z = norm3(axis && axis.length === 3 ? axis : [0, 0, 1]);
        let x = refDir && refDir.length === 3 ? refDir.slice() : [1, 0, 0];
        const d = dot3(x, z);
        x = [x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]];
        if (len3(x) < 1e-9) x = Math.abs(z[2]) < 0.9 ? cross3([0, 0, 1], z) : cross3([1, 0, 0], z);
        x = norm3(x);
        const y = cross3(z, x);
        return { x, y, z };
    }

    const applyBasis = (b, v) => [
        b.x[0] * v[0] + b.y[0] * v[1] + b.z[0] * v[2],
        b.x[1] * v[0] + b.y[1] * v[1] + b.z[1] * v[2],
        b.x[2] * v[0] + b.y[2] * v[1] + b.z[2] * v[2]
    ];
    const composeBasis = (parent, local) => ({
        x: applyBasis(parent, local.x), y: applyBasis(parent, local.y), z: applyBasis(parent, local.z)
    });

    /**
     * Проходит IfcLocalPlacement от заданного id до корня (PlacementRelTo = $)
     * и накапливает мировые координаты на каждом уровне.
     */
    // «Локально (0,0,0)» бывает по двум причинам, которые нельзя путать: файл
    // ТАК и написан (RelativePlacement = $), или мой же индекс не нашёл
    // сущность (пробел разбора) — второе нельзя тихо подменять нулём, иначе
    // отчёт лжёт увереннее, чем «не нашёл».
    const LOC_STATUS_NOTE = {
        'no-axis': ' [RelativePlacement = $ — так в файле]',
        'axis-not-found': ' [ссылка на Axis2Placement3D НЕ НАШЛАСЬ в индексе — возможен пробел разбора]',
        'no-location': ' [у Axis2Placement3D Location = $ — так в файле]',
        'point-not-found': ' [ссылка на CartesianPoint НЕ НАШЛАСЬ в индексе — возможен пробел разбора]'
    };

    function resolveChain(startPlacementId, idx) {
        const levels = [];
        let cur = startPlacementId;
        let guard = 0;
        while (cur != null && guard++ < 64) {
            const lp = idx.localPlacements.get(cur);
            if (!lp) { levels.push({ id: cur, missing: true }); break; }
            const ax = lp.rel != null ? idx.axis3d.get(lp.rel) : null;
            let location = V3_ZERO;
            let locStatus = 'ok';
            if (lp.rel == null) locStatus = 'no-axis';
            else if (!ax) locStatus = 'axis-not-found';
            else if (ax.loc == null) locStatus = 'no-location';
            else {
                const p = idx.points.get(ax.loc);
                if (!p) locStatus = 'point-not-found';
                else location = p;
            }
            levels.push({
                id: cur,
                relTo: lp.relTo,
                location,
                locStatus,
                axis: ax && ax.axis != null ? idx.dirs.get(ax.axis) : null,
                refDirection: ax && ax.refDir != null ? idx.dirs.get(ax.refDir) : null,
                hasAxis: !!ax
            });
            cur = lp.relTo;
        }
        levels.reverse(); // от корня к листу

        let origin = V3_ZERO;
        let basis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
        const trace = [];
        for (const lvl of levels) {
            const worldLoc = [
                origin[0] + basis.x[0] * lvl.location[0] + basis.y[0] * lvl.location[1] + basis.z[0] * lvl.location[2],
                origin[1] + basis.x[1] * lvl.location[0] + basis.y[1] * lvl.location[1] + basis.z[1] * lvl.location[2],
                origin[2] + basis.x[2] * lvl.location[0] + basis.y[2] * lvl.location[1] + basis.z[2] * lvl.location[2]
            ];
            trace.push({
                id: lvl.id, local: lvl.location, world: worldLoc,
                missing: lvl.missing, hasAxis: lvl.hasAxis, locStatus: lvl.locStatus
            });
            if (lvl.missing) break;
            basis = composeBasis(basis, buildBasis(lvl.axis, lvl.refDirection));
            origin = worldLoc;
        }
        return { trace, worldOrigin: origin, levels: levels.length };
    }

    function formatChainTrace(label, startId, idx, k) {
        const L = [`--- ${label} ---`];
        if (startId == null) {
            L.push('  ObjectPlacement = $ (нет размещения — сущность в абсолютном нуле).');
            return L;
        }
        const { trace, worldOrigin, levels } = resolveChain(startId, idx);
        L.push(`  Уровней в цепочке: ${levels}`);
        trace.forEach((t, i) => {
            const tag = i === 0 ? 'корень' : `шаг ${i}`;
            if (t.missing) {
                L.push(`  #${t.id} (${tag}): IfcLocalPlacement не найден в индексе — цепочка обрывается здесь.`);
                return;
            }
            const loc = t.local.map((v) => (v * k).toFixed(3)).join(', ');
            const wld = t.world.map((v) => (v * k).toFixed(3)).join(', ');
            const note = LOC_STATUS_NOTE[t.locStatus] || '';
            L.push(`  #${t.id} (${tag}): локально (${loc}) м → накоплено (${wld}) м${note}`);
        });
        L.push(`  Итог — мировая точка: ${worldOrigin.map((v) => (v * k).toFixed(3)).join(' / ')} м`);
        return L;
    }

    async function traceChain(file, unitScale) {
        if (busy) return;
        busy = true;
        const btn = $('ifcdChain');
        if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; }
        const base = out.textContent || '';
        show(base + '\n\nЧитаю файл повторно — строю индекс размещений…');
        setProgress(0);

        const idx = {
            localPlacements: new Map(), axis3d: new Map(), points: new Map(), dirs: new Map(),
            site: null, product: null, context: null
        };
        const decoder = new TextDecoder('latin1');
        let carry = '';
        let offset = 0;
        try {
            while (offset < file.size) {
                const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
                const buf = await slice.arrayBuffer();
                offset += buf.byteLength;
                const text = carry + decoder.decode(buf, { stream: offset < file.size });
                const cut = text.lastIndexOf(';');
                if (cut === -1) { carry = text; }
                else {
                    scanPlacementChunk(text.slice(0, cut + 1), idx);
                    carry = text.slice(cut + 1);
                }
                setProgress(offset / file.size);
                show(base + `\n\nЧитаю файл повторно — ${(offset / file.size * 100).toFixed(0)} %`);
                await new Promise((r) => setTimeout(r, 0));
            }
            if (carry.trim()) scanPlacementChunk(carry, idx);

            const k = unitScale || 1;
            const L = [
                '',
                '=== Цепочка размещения (IfcLocalPlacement) ===',
                `Индекс: LocalPlacement ${idx.localPlacements.size.toLocaleString('ru-RU')} · ` +
                `Axis2Placement3D ${idx.axis3d.size.toLocaleString('ru-RU')} · ` +
                `CartesianPoint ${idx.points.size.toLocaleString('ru-RU')} · ` +
                `Direction ${idx.dirs.size.toLocaleString('ru-RU')}`,
                ''
            ];
            if (idx.site) {
                L.push(...formatChainTrace(`IfcSite #${idx.site.id}`, idx.site.placementRef, idx, k));
            } else {
                L.push('--- IfcSite ---', '  Не найден.');
            }
            L.push('');
            if (idx.product) {
                L.push(...formatChainTrace(`${idx.product.type} #${idx.product.id} (типовой элемент)`, idx.product.placementRef, idx, k));
            } else {
                L.push('--- Типовой элемент ---', '  Ни одного распознанного IfcProduct не найдено.');
            }
            L.push(
                '',
                'Если у элемента цепочка короче, чем у IfcSite, или обрывается на',
                '«не найден» / PlacementRelTo = $ раньше — вот причина, по которой',
                'элемент не наследует мировые координаты площадки.'
            );

            // WorldCoordinateSystem контекста — мировой сдвиг ВНЕ цепочки вставки
            // сайта. IfcMapConversion (стандартный способ геопривязки IFC4) в
            // этом файле не встречается (см. основной отчёт выше) — если Site
            // и элемент выше в локальном нуле, а число тут большое, вот и разгадка:
            // веб-ifc отдаёт flatTransformation по цепочке размещения, а этот
            // контекст в неё не входит.
            L.push('', '--- IfcGeometricRepresentationContext.WorldCoordinateSystem ---');
            if (!idx.context) {
                L.push('  IfcGeometricRepresentationContext не найден.');
            } else if (idx.context.wcs == null) {
                L.push('  WorldCoordinateSystem = $ — контекст не задаёт отдельного мирового сдвига.');
            } else {
                const ax = idx.axis3d.get(idx.context.wcs);
                if (!ax) {
                    L.push(`  #${idx.context.id}: ссылка #${idx.context.wcs} на Axis2Placement3D не нашлась в индексе.`);
                } else {
                    const loc = ax.loc != null ? idx.points.get(ax.loc) : null;
                    const refDir = ax.refDir != null ? idx.dirs.get(ax.refDir) : null;
                    if (!loc) {
                        L.push(`  #${idx.context.id}: Location у #${idx.context.wcs} пуст или не нашёлся.`);
                    } else {
                        const locM = loc.map((v) => (v * k).toFixed(3)).join(', ');
                        L.push(`  #${idx.context.id} → #${idx.context.wcs}: точка (${locM}) м`);
                        if (refDir && refDir.length >= 2) {
                            const deg = (Math.atan2(refDir[1], refDir[0]) * 180 / Math.PI);
                            L.push(`  Направление оси X: (${refDir.map((v) => v.toFixed(5)).join(', ')}) — поворот ≈ ${deg.toFixed(3)}° от востока`);
                        }
                        const mag = Math.hypot(loc[0], loc[1], loc[2]) * k;
                        if (mag > 5) {
                            L.push(
                                '  ЭТО МИРОВОЙ СДВИГ ВНЕ ЦЕПОЧКИ РАЗМЕЩЕНИЯ: если у IfcSite и элемента',
                                '  выше локальные (0,0,0), а тут — большие числа, значит именно этот',
                                '  сдвиг несёт геометрию, и он не проходит через IfcLocalPlacement —',
                                '  вьювер (и web-ifc внутри него) его не видит и не применяет.'
                            );
                        }
                    }
                }
            }
            show(base + '\n' + L.join('\n'));
        } catch (error) {
            show(base + `\n\nЦепочку разобрать не удалось: ${error && error.message ? error.message : error}`);
        } finally {
            busy = false;
            setProgress(1);
            if (bar) bar.hidden = true;
            if (btn) { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
        }
    }

    async function analyze(file) {
        if (busy) return;
        busy = true;
        drop.classList.remove('is-over');
        if (actions) actions.hidden = true;
        show(`Читаю «${file.name}»…`);
        setProgress(0);

        const acc = {
            entities: 0,
            points: 0,
            points2d: 0,
            meshPoints: 0,
            meshMin: [Infinity, Infinity, Infinity],
            meshMax: [-Infinity, -Infinity, -Infinity],
            booleans: 0,
            hist: new Map(),
            kept: new Map(),
            header: { schema: '', fileName: '' },
            min: [Infinity, Infinity, Infinity],
            max: [-Infinity, -Infinity, -Infinity]
        };

        const started = performance.now();
        // latin1: IFC — это ASCII-совместимый STEP, кириллица там в \X2\-экранировании.
        const decoder = new TextDecoder('latin1');
        let carry = '';
        let offset = 0;

        try {
            while (offset < file.size) {
                const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
                const buf = await slice.arrayBuffer();
                offset += buf.byteLength;

                const text = carry + decoder.decode(buf, { stream: offset < file.size });
                // Режем по последней «;» — иначе сущность разорвётся на границе куска
                const cut = text.lastIndexOf(';');
                if (cut === -1) {
                    carry = text;
                } else {
                    scanChunk(text.slice(0, cut + 1), acc);
                    carry = text.slice(cut + 1);
                }

                setProgress(offset / file.size);
                show(`Читаю «${file.name}» — ${(offset / file.size * 100).toFixed(0)} %`);
                await new Promise(r => setTimeout(r, 0));
            }
            if (carry.trim()) scanChunk(carry, acc);

            setProgress(1);
            show(buildReport(file, acc, performance.now() - started));
            if (actions) actions.hidden = false;
            lastFile = file;
            lastUnitScale = lengthUnitOf(acc).scale || 1;
            if (btnChain) btnChain.disabled = false;
        } catch (error) {
            show(`Не удалось разобрать файл: ${error && error.message ? error.message : error}`);
        } finally {
            busy = false;
            if (bar) bar.hidden = true;
        }
    }

    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.click();
        }
    });
    input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (file) analyze(file);
    });
    ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, (e) => {
        e.preventDefault();
        if (type === 'dragleave') drop.classList.remove('is-over');
    }));
    drop.addEventListener('drop', (e) => {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) analyze(file);
    });

    const copyBtn = $('ifcdCopy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
        if (!out) return;
        try {
            await navigator.clipboard.writeText(out.textContent || '');
            const was = copyBtn.innerHTML;
            copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Скопировано';
            setTimeout(() => { copyBtn.innerHTML = was; }, 1600);
        } catch (_) {
            // Буфер закрыт политикой — выделяем, чтобы скопировать руками
            const range = document.createRange();
            range.selectNodeContents(out);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    });

    if (btnChain) {
        btnChain.disabled = true;
        btnChain.addEventListener('click', () => {
            if (!lastFile || busy) return;
            traceChain(lastFile, lastUnitScale);
        });
    }

    const resetBtn = $('ifcdReset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        input.value = '';
        if (out) { out.hidden = true; out.textContent = ''; }
        if (actions) actions.hidden = true;
        lastFile = null;
        lastUnitScale = 1;
        if (btnChain) btnChain.disabled = true;
    });
})();
