/**
 * Профиль IFC-файла: компактная выжимка вместо самого файла.
 *
 * Зачем: рабочие модели весят десятки-сотни мегабайт, содержат проектные
 * данные заказчика и просто так их никуда не выложить. При этом почти на любой
 * вопрос («почему не открывается», «почему улетело», «почему пусто») отвечают
 * заголовок, состав классов и координатные габариты — это десятки килобайт.
 *
 * Запуск:
 *   node tools/ifc-profile.mjs "C:\путь\к\модели.ifc"
 *   node tools/ifc-profile.mjs модель.ifc > профиль.txt
 *
 * Ключи:
 *   --names     включить имена объектов (по умолчанию вырезаны — в них проектные данные)
 *   --top=N     сколько классов показывать (по умолчанию 40)
 *
 * Файл читается потоком: 500 МБ не поднимут память.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const withNames = args.includes('--names');
const topN = Number((args.find((a) => a.startsWith('--top=')) || '').split('=')[1]) || 40;

if (!file) {
    console.error('Укажите путь к IFC: node tools/ifc-profile.mjs модель.ifc');
    process.exit(1);
}

const stat = fs.statSync(file);
const counts = new Map();
/** Сущности, по которым видно геопривязку и настройки экспорта. */
const KEEP_ENTITIES = [
    'IFCPROJECT', 'IFCSITE', 'IFCMAPCONVERSION', 'IFCPROJECTEDCRS',
    'IFCGEOMETRICREPRESENTATIONCONTEXT', 'IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT',
    'IFCUNITASSIGNMENT', 'IFCAXIS2PLACEMENT3D', 'IFCLOCALPLACEMENT'
];
const keepLimit = { IFCAXIS2PLACEMENT3D: 3, IFCLOCALPLACEMENT: 3 };
const samples = new Map();

const header = [];
let inHeader = false;
let inData = false;
let lineNo = 0;
let dataLines = 0;
let booleanOps = 0;
let truncated = true;

// Габариты координат — точные, по всем точкам файла
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
let pointSamples = 0;
const POINT_RE = /IFCCARTESIANPOINT\s*\(\s*\(([^)]*)\)/i;

const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity
});

for await (const raw of rl) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;

    if (/^HEADER;/i.test(line)) { inHeader = true; continue; }
    if (/^ENDSEC;/i.test(line)) { inHeader = false; continue; }
    if (/^DATA;/i.test(line)) { inData = true; continue; }
    if (/^END-ISO-10303-21;/i.test(line)) { truncated = false; continue; }

    if (inHeader) { header.push(line); continue; }
    if (!inData) continue;

    dataLines++;

    const m = line.match(/^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/i);
    if (m) {
        const cls = m[2].toUpperCase();
        counts.set(cls, (counts.get(cls) || 0) + 1);
        if (KEEP_ENTITIES.includes(cls)) {
            const limit = keepLimit[cls] ?? 6;
            if (!samples.has(cls)) samples.set(cls, []);
            const list = samples.get(cls);
            if (list.length < limit) list.push(line.length > 400 ? line.slice(0, 400) + '…' : line);
        }
    }

    if (line.includes('IFCBOOLEANRESULT') || line.includes('IFCBOOLEANCLIPPINGRESULT')) booleanOps++;

    // Габарит считаем по ВСЕМ точкам, а не по выборке: «каждая N-я строка»
    // накладывается на период файла (у экспортёров он строго регулярный) и
    // стабильно промахивается мимо нужных строк. Дешёвый indexOf отсекает
    // 90 % строк до регулярки, так что на 75 МБ это всё равно секунды.
    if (line.indexOf('IFCCARTESIANPOINT') >= 0) {
        const pm = line.match(POINT_RE);
        if (pm) {
            const nums = pm[1].split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
            if (nums.length >= 2) {
                pointSamples++;
                const [x, y, z = 0] = nums;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
        }
    }
}

const maskStrings = (s) => s.replace(/'((?:[^']|'')*)'/g, (full, inner) =>
    inner.length > 2 ? `'<текст ${inner.length} симв.>'` : full);

/**
 * Технические строки (схема, вид, экспортёр, EPSG/МСК, единицы) нужны для
 * диагностики и проектных данных не содержат — их не режем никогда.
 * Прячем только то, что действительно про объект: имя файла, автора,
 * организацию, названия проекта и площадки.
 */
const TECHNICAL_ENTITIES = new Set([
    'IFCMAPCONVERSION', 'IFCPROJECTEDCRS', 'IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT',
    'IFCUNITASSIGNMENT', 'IFCGEOMETRICREPRESENTATIONCONTEXT',
    'IFCAXIS2PLACEMENT3D', 'IFCLOCALPLACEMENT'
]);

function scrubEntity(line, cls) {
    if (withNames || TECHNICAL_ENTITIES.has(cls)) return line;
    return maskStrings(line);
}

function scrubHeaderLine(line) {
    if (withNames) return line;
    // FILE_SCHEMA и FILE_DESCRIPTION — чистая техника, оставляем как есть
    if (/^FILE_SCHEMA/i.test(line) || /^FILE_DESCRIPTION/i.test(line)) return line;
    // FILE_NAME: скрываем имя файла, автора и организацию (поля 1, 3, 4),
    // сохраняем дату, препроцессор и экспортёр — по ним и видно, чем выгружено
    if (/^FILE_NAME/i.test(line)) {
        let idx = 0;
        return line.replace(/'((?:[^']|'')*)'/g, (full, inner) => {
            idx++;
            const hide = idx === 1 || idx === 3 || idx === 4;
            return hide && inner.length > 2 ? `'<текст ${inner.length} симв.>'` : full;
        });
    }
    return maskStrings(line);
}

const fmt = (n) => Number.isFinite(n) ? n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—';
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const totalEntities = sorted.reduce((n, [, c]) => n + c, 0);

const out = [];
out.push('=== ПРОФИЛЬ IFC ===');
out.push(`Файл:        ${path.basename(file)}`);
out.push(`Размер:      ${(stat.size / 1024 / 1024).toFixed(1)} МБ, строк ${lineNo.toLocaleString('ru-RU')}`);
out.push(`Завершён:    ${truncated ? 'НЕТ — нет END-ISO-10303-21, файл обрезан' : 'да'}`);
out.push(`Сущностей:   ${totalEntities.toLocaleString('ru-RU')} (уникальных классов ${counts.size})`);
out.push(`Boolean/CSG: ${booleanOps.toLocaleString('ru-RU')}`);
out.push('');
out.push('--- HEADER ---');
header.forEach((h) => out.push(scrubHeaderLine(h)));
out.push('');
out.push('--- ГАБАРИТЫ КООРДИНАТ (по всем ' + pointSamples.toLocaleString('ru-RU') + ' точкам) ---');
out.push(`X: ${fmt(minX)} … ${fmt(maxX)}   (протяжённость ${fmt(maxX - minX)})`);
out.push(`Y: ${fmt(minY)} … ${fmt(maxY)}   (протяжённость ${fmt(maxY - minY)})`);
out.push(`Z: ${fmt(minZ)} … ${fmt(maxZ)}   (протяжённость ${fmt(maxZ - minZ)})`);
out.push(`Максимум по модулю: ${fmt(Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY)))}`);
out.push('');
out.push(`--- КЛАССЫ (первые ${topN}) ---`);
sorted.slice(0, topN).forEach(([cls, n]) => {
    out.push(`${String(n).padStart(9)}  ${cls}`);
});
if (sorted.length > topN) out.push(`… и ещё ${sorted.length - topN} классов`);
out.push('');
out.push('--- ГЕОПРИВЯЗКА И ЕДИНИЦЫ ---');
for (const cls of KEEP_ENTITIES) {
    const list = samples.get(cls);
    if (!list?.length) {
        if (['IFCMAPCONVERSION', 'IFCPROJECTEDCRS'].includes(cls)) out.push(`${cls}: НЕТ`);
        continue;
    }
    out.push(`${cls} (${counts.get(cls)} шт., показаны первые ${list.length}):`);
    list.forEach((l) => out.push('  ' + scrubEntity(l, cls)));
}
out.push('');
out.push(withNames
    ? '(имена объектов включены ключом --names)'
    : '(строковые значения вырезаны; чтобы оставить — запустите с ключом --names)');

console.log(out.join('\n'));
