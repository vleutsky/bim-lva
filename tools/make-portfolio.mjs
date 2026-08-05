/**
 * Собирает portfolio.html из index.html — версию сайта для отклика на вакансии.
 *
 * Зачем отдельная страница: основной сайт продаёт услуги, и работодателю блоки
 * «Разработка под заказ», «Комплексные услуги команды» и кнопка доната читаются
 * как «у кандидата свой бизнес». Портфолио оставляет ровно то, что подтверждает
 * квалификацию: приложения, об авторе, обучающие материалы и навыки.
 *
 * Страница генерируется, а не копируется: две страницы, которые ведут руками,
 * расходятся после первой же правки. Каждая подстановка требует ровно одного
 * вхождения и падает иначе — молчаливого расхождения не будет.
 *
 * Запуск: npm run portfolio
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'portfolio.html');

/** Заменяет ровно одно вхождение, иначе падает: страница не должна тихо разъехаться. */
function replaceOnce(source, from, to, what) {
    const count = source.split(from).length - 1;
    if (count !== 1) {
        throw new Error(`${what}: ожидалось 1 вхождение, найдено ${count}. Обновите tools/make-portfolio.mjs.`);
    }
    return source.replace(from, to);
}

/** Заменяет все вхождения, но требует, чтобы их было ожидаемое число. */
function replaceExactly(source, from, to, times, what) {
    const count = source.split(from).length - 1;
    if (count !== times) {
        throw new Error(`${what}: ожидалось ${times} вхождений, найдено ${count}. Обновите tools/make-portfolio.mjs.`);
    }
    return source.split(from).join(to);
}

let html = await fs.readFile(SRC, 'utf8');

// ---- 1. Заголовок и описание: страница про инженера, а не про магазин ----
html = replaceOnce(
    html,
    '<title>BIM.LVA | Портфель приложений · Владимир Леуцкий</title>',
    '<title>Владимир Леуцкий — BIM-инженер и разработчик инструментов</title>',
    'заголовок страницы'
);
html = replaceOnce(
    html,
    '<meta name="description" content="Презентация авторских BIM-приложений: Composer IFC, Composer AI, плагины Civil 3D, Navisworks и Plant 3D от Владимира Леуцкого.">',
    '<meta name="description" content="Портфолио: браузерный просмотрщик сводных IFC-моделей, плагины Civil 3D, Navisworks и Plant 3D, автоматизация проектирования инфраструктуры.">\n    <meta name="robots" content="noindex">',
    'описание страницы'
);

// ---- 2. Кнопка доната в шапке ----
html = replaceOnce(
    html,
    `                <a href="https://pay.cloudtips.ru/p/0265eeea" target="_blank" rel="noopener" class="nav-support" title="Поддержать">
                    <i class="fa-solid fa-heart"></i>
                    <span class="hide-sm">Поддержать</span>
                </a>
`,
    '',
    'кнопка доната в шапке'
);

// ---- 3. Пункт меню «Услуги» → «Навыки» (десктоп и мобильное меню) ----
html = replaceExactly(
    html,
    '<a href="#services">Услуги</a>',
    '<a href="#services">Навыки</a>',
    2,
    'пункт меню «Услуги»'
);

// ---- 4. Блок «Разработка под заказ» из списка приложений ----
html = replaceOnce(
    html,
    `            <div class="custom-dev reveal">
                <div>
                    <h3>Разработка под заказ</h3>
                    <p>Нужен уникальный инструмент под стандарты компании? Плагин или Desktop-приложение для Navisworks, Civil&nbsp;3D, AutoCAD или Plant&nbsp;3D.</p>
                </div>
                <button class="btn btn-primary" onclick="openRequestModal('Разработка нового плагина')">Оставить заявку <i class="fa-regular fa-comment-dots"></i></button>
            </div>
`,
    '',
    'блок «Разработка под заказ»'
);

// ---- 5. «Комплексные услуги команды» → «Навыки» ----
// Содержательный список остаётся: для рекрутера это подтверждение
// компетенций. Меняется рамка — компетенции кандидата, а не прайс команды.
html = replaceOnce(
    html,
    `                <div class="section-kicker">My Team</div>
                <h2>Комплексные услуги команды</h2>
                <p>Полный цикл: изыскания и 3D-моделирование, экспертиза и разработка инструментов.</p>`,
    `                <div class="section-kicker">Skills</div>
                <h2>Навыки</h2>
                <p>Разделы проектирования, с которыми работаю, и стек, на котором пишу инструменты.</p>`,
    'заголовок раздела услуг'
);
html = replaceOnce(
    html,
    '                    <h3>Проектирование</h3>',
    '                    <h3>Разделы проектирования</h3>',
    'подзаголовок «Проектирование»'
);
html = replaceOnce(
    html,
    '                    <h3>Программирование</h3>',
    '                    <h3>Разработка</h3>',
    'подзаголовок «Программирование»'
);

// ---- 6. Кнопка доната в подвале ----
html = replaceOnce(
    html,
    `                    <a href="https://pay.cloudtips.ru/p/0265eeea" target="_blank" rel="noopener" class="btn btn-ghost btn-sm"><i class="fa-solid fa-heart" style="color:#e85d4c"></i> Поддержать проект</a>
`,
    '',
    'кнопка доната в подвале'
);
html = replaceOnce(
    html,
    '<p>Персональный сайт и портфель приложений инженера Владимира Леуцкого. Делаем BIM удобным.</p>',
    '<p>Владимир Леуцкий — инженер инфраструктуры и разработчик BIM-инструментов.</p>\n                    <p style="margin-top:.5rem"><a href="index.html">Основной сайт BIM.LVA →</a></p>',
    'описание в подвале'
);

await fs.writeFile(OUT, html);

// Проверка результата: коммерческих следов остаться не должно.
const leftovers = [
    ['pay.cloudtips.ru', 'ссылка доната'],
    ['Разработка под заказ', 'блок разработки под заказ'],
    ['Комплексные услуги', 'заголовок услуг'],
    ['My Team', 'подпись раздела'],
    ['YOUR_LINK_HERE', 'заглушка ссылки']
];
const found = leftovers.filter(([needle]) => html.includes(needle));
if (found.length) {
    throw new Error(`В portfolio.html осталось лишнее: ${found.map(([, name]) => name).join(', ')}`);
}

console.log(`portfolio.html собран из index.html · ${(html.length / 1024).toFixed(0)} КБ`);
console.log('Коммерческих блоков и заглушек не осталось.');
