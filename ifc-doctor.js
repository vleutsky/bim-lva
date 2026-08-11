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

    const resetBtn = $('ifcdReset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
        input.value = '';
        if (out) { out.hidden = true; out.textContent = ''; }
        if (actions) actions.hidden = true;
    });
})();
