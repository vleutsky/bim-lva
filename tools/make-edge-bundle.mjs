/**
 * Собирает однофайловую версию Edge Function: bundled.ts
 *
 * Функция состоит из index.ts и license-lic.js — формат ключа общий с
 * тестами, чтобы выпуск и проверка не разошлись. Но редактор функций в
 * дашборде Supabase удобен только для одного файла, и требовать ради этого
 * установку CLI — лишний барьер.
 *
 * Поэтому здесь модуль формата вклеивается в функцию механически. Файл
 * генерируется, а не правится руками: правки вносятся в исходники, потом
 * `npm run edge-bundle`.
 *
 * Запуск: npm run edge-bundle
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'supabase', 'functions', 'license-issue');
const OUT = path.join(DIR, 'bundled.ts');

// Строку импорта раньше держали здесь дословно, и генератор падал от любого
// добавления функции в список — правку приходилось делать в двух местах.
// Ищем импорт по форме, а состав проверяем отдельно.
const IMPORT_RE = /^import\s*\{[^}]*\}\s*from\s*["']\.\/license-lic\.js["'];?[ \t]*$/gm;

const index = await fs.readFile(path.join(DIR, 'index.ts'), 'utf8');
const format = await fs.readFile(path.join(DIR, 'license-lic.js'), 'utf8');

const importMatches = index.match(IMPORT_RE) ?? [];
if (importMatches.length !== 1) {
    throw new Error(
        `В index.ts ожидался ровно один импорт ./license-lic.js, найдено ${importMatches.length}.`
    );
}
const IMPORT_LINE = importMatches[0];

// Всё, что функция берёт из модуля, должно в модуле существовать: иначе
// bundled.ts соберётся, а упадёт уже в Supabase, где отлаживать неудобно.
const imported = (IMPORT_LINE.match(/\{([^}]*)\}/)?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
const missing = imported.filter(
    (name) => !new RegExp(`^export (async )?(function|const) ${name}\\b`, 'm').test(format)
);
if (missing.length) {
    throw new Error(`index.ts импортирует из license-lic.js то, чего там нет: ${missing.join(', ')}`);
}

// Внутри одного файла экспортировать нечего: убираем `export`, оставляя тела
// функций как есть. Комментарии сохраняем — они объясняют формат ключа.
const inlined = format
    .replace(/^export const /gm, 'const ')
    .replace(/^export function /gm, 'function ')
    .replace(/^export async function /gm, 'async function ')
    .trim();

const banner = `// ВНИМАНИЕ: файл собран автоматически из index.ts и license-lic.js.
// Не правьте его — правки затрёт следующая сборка. Меняйте исходники и
// выполняйте: npm run edge-bundle
//
// Эта версия нужна тем, кто разворачивает функцию через редактор в дашборде
// Supabase: там удобно вставить один файл. Через CLI разворачивайте обычные
// index.ts + license-lic.js — они и есть источник правды.
`;

const bundled = banner + index.replace(
    IMPORT_LINE,
    `// ---- начало вклеенного license-lic.js ----\n${inlined}\n// ---- конец вклеенного license-lic.js ----`
);

await fs.writeFile(OUT, bundled);

// Простая защита от рассинхрона: всё, что функция берёт из модуля, должно
// оказаться в результате.
const needMust = ['function signLicenseFile', 'function importRsaSigningKey', 'function canonicalString'];
for (const needed of [...needMust, ...imported.map((n) => `function ${n}`)]) {
    if (!bundled.includes(needed)) throw new Error(`В bundled.ts не попало: ${needed}`);
}
if (bundled.includes('./license-lic.js')) {
    throw new Error('В bundled.ts остался импорт внешнего файла.');
}

console.log(`bundled.ts собран · ${(bundled.length / 1024).toFixed(1)} КБ`);
console.log('Для дашборда: вставить целиком одним файлом.');
