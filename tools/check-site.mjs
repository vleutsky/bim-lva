/**
 * Проверка страниц сайта: открывает каждую в Chromium и ищет то, что рекрутер
 * заметит раньше вас — битые ссылки, заглушки, ошибки в консоли.
 *
 * Внешние адреса проверяются только на вид (заглушки, http вместо https):
 * ходить наружу из проверки нельзя, да и чужая недоступность — не наша ошибка.
 *
 * Запуск: npm run check-site
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startStaticServer } from './static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = [
    'index.html', 'portfolio.html', 'cabinet.html',
    'license-admin.html', 'case_inventor.html', 'plugin_ksi.html',
    'testing.html', 'composer.html'
];

/** Явные признаки незаполненного шаблона. */
const PLACEHOLDERS = /YOUR_LINK_HERE|PLACEHOLDER|XXXXXX|example\.com|lorem ipsum|TODO/i;

const problems = [];   // ломают страницу — это чинить
const warnings = [];   // стоит знать, но само по себе не поломка

async function resolveChromium() {
    const explicit = process.env.SMOKE_CHROMIUM;
    if (explicit) return explicit;
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!base) return undefined;
    for (const dir of (await fs.readdir(base).catch(() => []))
        .filter((d) => d.startsWith('chromium-')).sort().reverse()) {
        const bin = path.join(base, dir, 'chrome-linux', 'chrome');
        if (await fs.access(bin).then(() => true, () => false)) return bin;
    }
    return undefined;
}

const { server, port } = await startStaticServer(ROOT);
const browser = await chromium.launch({ executablePath: await resolveChromium() });

for (const page of PAGES) {
    if (!(await fs.access(path.join(ROOT, page)).then(() => true, () => false))) {
        problems.push(`${page}: файла нет`);
        continue;
    }
    const tab = await browser.newPage();
    // Часть страниц тянет Tailwind и шрифты с CDN. В песочнице выход наружу
    // закрыт, и падение такого скрипта — свойство проверки, а не сайта.
    const blockedExternal = [];
    const scriptErrors = [];
    tab.on('requestfailed', (req) => {
        if (!req.url().startsWith(`http://127.0.0.1:${port}/`)) blockedExternal.push(req.url());
    });
    tab.on('pageerror', (err) => scriptErrors.push(err.message));
    const local404 = [];
    tab.on('response', (res) => {
        if (res.status() >= 400 && res.url().startsWith(`http://127.0.0.1:${port}/`)) {
            local404.push({ status: res.status(), path: res.url().split(`:${port}`)[1] });
        }
    });

    await tab.goto(`http://127.0.0.1:${port}/${page}`, { waitUntil: 'load', timeout: 60_000 });
    await tab.waitForTimeout(500);

    const info = await tab.evaluate(() => ({
        title: document.title,
        text: document.body.innerText,
        links: [...document.querySelectorAll('a[href]')].map((a) => ({
            href: a.getAttribute('href'),
            text: (a.textContent || '').trim().slice(0, 40)
        })),
        // Картинка с onerror показывает запасной блок вместо «сломанной» иконки:
        // файла нет, но страница выглядит целой.
        brokenImages: [...document.querySelectorAll('img')]
            .filter((img) => img.complete && img.naturalWidth === 0)
            .map((img) => ({
                src: img.getAttribute('src') || '',
                hasFallback: img.hasAttribute('onerror')
            }))
    }));

    const withFallback = new Set(
        info.brokenImages.filter((i) => i.hasFallback).map((i) => i.src.replace(/^\.?\//, ''))
    );
    for (const miss of local404) {
        const rel = miss.path.replace(/^\//, '');
        if (withFallback.has(rel)) {
            warnings.push(`${page}: нет файла ${miss.path} — показывается заглушка, положите настоящий`);
        } else {
            problems.push(`${page}: HTTP ${miss.status} — ${miss.path}`);
        }
    }

    if (PLACEHOLDERS.test(info.text)) problems.push(`${page}: на странице виден текст-заглушка`);

    for (const link of info.links) {
        const href = link.href;
        if (PLACEHOLDERS.test(href)) {
            problems.push(`${page}: ссылка-заглушка «${link.text}» → ${href}`);
        }
        if (href.startsWith('http://')) {
            // Не переписываем на https молча: чужой сервер может его не отдавать,
            // и «исправление» превратит рабочую ссылку в битую.
            warnings.push(`${page}: ссылка по http, не https — «${link.text}» → ${href}`);
        }
        // Внутренние адреса проверяем по факту наличия файла.
        if (/^[\w./-]+\.html(#.*)?$/.test(href)) {
            const target = href.split('#')[0];
            if (!(await fs.access(path.join(ROOT, target)).then(() => true, () => false))) {
                problems.push(`${page}: ссылка на несуществующий файл «${link.text}» → ${target}`);
            }
        }
        // Якоря должны существовать на самой странице.
        if (href.startsWith('#') && href.length > 1) {
            const ok = await tab.evaluate((id) => !!document.getElementById(id), href.slice(1));
            if (!ok) problems.push(`${page}: якорь «${link.text}» → ${href} никуда не ведёт`);
        }
    }

    for (const err of scriptErrors) {
        if (blockedExternal.length) {
            warnings.push(`${page}: «${err}» — вероятно из-за недоступного в проверке CDN`);
        } else {
            problems.push(`${page}: ошибка скрипта — ${err}`);
        }
    }

    console.log(`${page.padEnd(22)} ${info.links.length} ссылок · «${info.title.slice(0, 60)}»`);
    await tab.close();
}

await browser.close();
server.close();

if (warnings.length) {
    console.log(`\nПредупреждения (${new Set(warnings).size}):`);
    for (const w of [...new Set(warnings)]) console.log(`  · ${w}`);
}

if (problems.length) {
    console.error(`\nПроблемы (${new Set(problems).size}):`);
    for (const p of [...new Set(problems)]) console.error(`  · ${p}`);
    process.exit(1);
}
console.log('\nOK — заглушек, битых ссылок и локальных 404 нет.');
