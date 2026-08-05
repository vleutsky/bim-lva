/**
 * Собирает тестовую копию вьювера: bim-lva-composer-ifc-preview.html
 *
 * Нужна, чтобы щупать правки на живом сайте, не подменяя рабочий Composer.
 * Копия генерируется, а не создаётся руками, — иначе она молча разойдётся с
 * оригиналом после первой же правки.
 *
 * Запуск: npm run preview
 */
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'bim-lva-composer-ifc.html');
const OUT = path.join(ROOT, 'bim-lva-composer-ifc-preview.html');

/** Короткий хеш коммита — чтобы в «О продукте» было видно, что именно проверяем. */
function gitShortSha() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })
            .toString().trim();
    } catch {
        return 'nogit';
    }
}

/** Заменяет ровно одно вхождение, иначе падает: молча разъехаться копия не должна. */
function replaceOnce(source, from, to, what) {
    const count = source.split(from).length - 1;
    if (count !== 1) {
        throw new Error(`${what}: ожидалось 1 вхождение, найдено ${count}. Обновите tools/make-preview.mjs.`);
    }
    return source.replace(from, to);
}

const BADGE_CSS = `
        /* ---- Метка тестовой сборки ---- */
        .preview-badge {
            position: fixed;
            left: 50%;
            top: 0;
            transform: translateX(-50%);
            z-index: 10000;
            padding: 2px 14px 3px;
            border: 1px solid var(--accent);
            border-top: 0;
            border-radius: 0 0 4px 4px;
            background: var(--accent);
            color: #fff;
            font-family: 'IBM Plex Mono', monospace;
            font-size: 11px;
            letter-spacing: .06em;
            pointer-events: none;
        }
    </style>`;

let html = await fs.readFile(SRC, 'utf8');
const sha = gitShortSha();

// 1. Service worker не регистрируем. Он встаёт в корневую область видимости —
//    ту же, что у рабочего Composer, — и регистрация другого скрипта в той же
//    области заменила бы рабочую. Офлайн на копии из-за этого не проверить.
html = replaceOnce(
    html,
    `        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('./sw-composer.js?v=81').catch(err => {
                    console.warn('SW register failed', err);
                });
            });
        }`,
    `        // Тестовая копия service worker не регистрирует: его область видимости —
        // корень сайта, та же, что у рабочего Composer, и регистрация другого
        // скрипта в ней заменила бы рабочую. Офлайн проверяйте на основной версии.`,
    'регистрация service worker'
);

// 2. Метка в «О продукте», заголовке вкладки и на самой странице —
//    тестовую сборку нельзя перепутать с рабочей.
html = replaceOnce(
    html,
    `            product: 'BIM.LVA Composer IFC',`,
    `            product: 'BIM.LVA Composer IFC — ТЕСТ',`,
    'название продукта'
);
html = replaceOnce(
    html,
    `            buildId: 'e552c86',`,
    `            buildId: '${sha}-preview',`,
    'идентификатор сборки'
);
html = replaceOnce(html, '\n    </style>', BADGE_CSS, 'конец блока стилей');
html = replaceOnce(
    html,
    '<body>\n',
    `<body>\n    <div class="preview-badge">ТЕСТОВАЯ СБОРКА · ${sha}</div>\n`,
    'начало body'
);

await fs.writeFile(OUT, html);
console.log(`${path.basename(OUT)} собран из ${path.basename(SRC)} · ${sha}`);
console.log('Service worker в копии отключён, метка сборки проставлена.');
