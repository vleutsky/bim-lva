#!/usr/bin/env node
/**
 * Мировой габарит и привязка IFC — без загрузки файла в память целиком.
 *
 * Печатает min/max по X/Y/Z всех IFCCARTESIANPOINT: это те же числа, что Civil 3D
 * показывает в «Свойства поверхности → Статистика». Если они сходятся с Civil —
 * файл уехал в IFC со своими мировыми координатами.
 *
 *   node tools/extract-ifc-coords.mjs "У2-24.556-ПД-ТК.06.23-ПЗУ.ifc"
 *
 * Осторожно: координаты в файле — в единицах файла (см. IFCUNITASSIGNMENT ниже),
 * у Civil-экспорта это обычно метры, у Revit/Tekla бывают миллиметры.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const file = process.argv[2];
if (!file) {
    console.error('Использование: node tools/extract-ifc-coords.mjs <file.ifc>');
    process.exit(1);
}
if (!fs.existsSync(file)) {
    console.error(`Файл не найден: ${file}`);
    process.exit(1);
}

const sizeMb = fs.statSync(file).size / 1024 / 1024;
console.log(`\nФайл:   ${path.basename(file)}  (${sizeMb.toFixed(1)} МБ)`);

// Строки заголовка и привязки — их немного, показываем целиком.
const HEAD_PATTERNS = [
    ['FILE_SCHEMA', /FILE_SCHEMA/i],
    ['FILE_NAME', /FILE_NAME/i],
    ['Единицы', /IFCUNITASSIGNMENT|IFCSIUNIT|IFCCONVERSIONBASEDUNIT/i],
    ['Проект', /=\s*IFCPROJECT\b/i],
    ['Площадка', /=\s*IFCSITE\b/i],
    ['Здание', /=\s*IFCBUILDING\b/i],
    ['Геопривязка', /IFCMAPCONVERSION|IFCPROJECTEDCRS/i]
];
const headHits = new Map(HEAD_PATTERNS.map(([label]) => [label, []]));
const HEAD_LIMIT = 4; // по столько строк на раздел — остальное шум

const point = /IFCCARTESIANPOINT\s*\(\s*\(([^)]*)\)/i;
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
let points = 0;

const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'latin1' }),
    crlfDelay: Infinity
});

for await (const line of rl) {
    for (const [label, re] of HEAD_PATTERNS) {
        const hits = headHits.get(label);
        if (hits.length < HEAD_LIMIT && re.test(line)) hits.push(line.trim().slice(0, 220));
    }
    const m = point.exec(line);
    if (!m) continue;
    const nums = m[1].split(',').map(s => Number(s.trim()));
    if (nums.length < 2 || nums.some(n => !Number.isFinite(n))) continue;
    points++;
    for (let i = 0; i < 3; i++) {
        const v = nums[i];
        if (v === undefined) continue;      // 2D-точки: Z просто нет
        if (v < min[i]) min[i] = v;
        if (v > max[i]) max[i] = v;
    }
}

console.log(`Точек:  ${points.toLocaleString('ru-RU')}\n`);

for (const [label] of HEAD_PATTERNS) {
    const hits = headHits.get(label);
    if (!hits.length) continue;
    console.log(`--- ${label} ---`);
    hits.forEach(h => console.log('  ' + h));
    console.log('');
}

if (!points) {
    console.log('IFCCARTESIANPOINT не найдено — файл сжат или это не STEP-версия IFC.');
    process.exit(0);
}

const axis = ['X', 'Y', 'Z'];
console.log('--- Мировой габарит (единицы файла) ---');
for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(min[i])) continue;
    const span = max[i] - min[i];
    console.log(
        `  ${axis[i]}: ${min[i].toFixed(3)} … ${max[i].toFixed(3)}   (протяжённость ${span.toFixed(3)})`
    );
}
console.log('\nСравните с Civil 3D: «Свойства поверхности → Статистика».');
console.log('Внимание: в габарит попадают и точки локальных систем координат');
console.log('(вставки, направления), поэтому минимум может уходить в 0 — смотрите на максимум.');
