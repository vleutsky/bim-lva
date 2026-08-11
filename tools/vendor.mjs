/**
 * Собирает вендорные зависимости вьювера в `assets/vendor/`.
 *
 * Зачем: Composer тянул three, web-ifc, geotiff, qrcode и шрифты с unpkg /
 * jsdelivr / Google Fonts. Это три чужих домена в критическом пути загрузки,
 * из-за них не работал офлайн (service worker пропускает кросс-домен) и
 * утекали IP пользователей. Всё нужное лежит рядом с сайтом.
 *
 * Запуск: npm ci && npm run vendor
 * Результат коммитится — сайт остаётся статикой без шага сборки.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'vendor');

/**
 * Адрес пакета в node_modules напрямую: require.resolve не годится — three и
 * geotiff закрывают `./package.json` полем "exports".
 */
function pkgDir(name) {
    return path.join(ROOT, 'node_modules', name);
}

async function pkgVersion(name) {
    const raw = await fs.readFile(path.join(pkgDir(name), 'package.json'), 'utf8');
    return JSON.parse(raw).version;
}

async function copy(from, to) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
}

/** Точки входа three/addons, которые импортирует Composer. */
const THREE_ADDONS = [
    'controls/OrbitControls.js',
    'controls/TransformControls.js',
    'loaders/FBXLoader.js',
    'loaders/GLTFLoader.js',
    'loaders/OBJLoader.js',
    'loaders/STLLoader.js',
    'loaders/PLYLoader.js',
    'loaders/ColladaLoader.js',
    'loaders/TDSLoader.js',
    'utils/BufferGeometryUtils.js',
    // «Толстые» линии: у обычной THREE.Line в WebGL linewidth всегда 1 px
    // (ограничение самого API, не three). Line2 рисует линию инстансами
    // квадов — отсюда и настраиваемая толщина, и попадание лучом.
    'lines/Line2.js',
    'lines/LineGeometry.js',
    'lines/LineMaterial.js'
];

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Аддоны three импортируют друг друга и `three` по bare-спецификатору.
 * Копируем не список, а его транзитивное замыкание по относительным путям —
 * иначе FBXLoader приедет без fflate и упадёт в рантайме.
 */
async function copyThreeAddons(jsmDir, outDir) {
    const queue = [...THREE_ADDONS];
    const done = new Set();
    while (queue.length) {
        const rel = path.normalize(queue.pop());
        if (done.has(rel)) continue;
        done.add(rel);
        const src = path.join(jsmDir, rel);
        const code = await fs.readFile(src, 'utf8');
        await copy(src, path.join(outDir, rel));
        for (const m of code.matchAll(IMPORT_RE)) {
            const spec = m[1] || m[2];
            if (!spec?.startsWith('.')) continue; // 'three' резолвит importmap
            queue.push(path.join(path.dirname(rel), spec));
        }
    }
    return done.size;
}

async function main() {
    await fs.rm(OUT, { recursive: true, force: true });

    // --- three ---
    const threeDir = pkgDir('three');
    await copy(
        path.join(threeDir, 'build', 'three.module.js'),
        path.join(OUT, 'three', 'three.module.js')
    );
    const addonCount = await copyThreeAddons(
        path.join(threeDir, 'examples', 'jsm'),
        path.join(OUT, 'three', 'addons')
    );

    // --- web-ifc: api + wasm рядом, чтобы WASM_PATH был локальным ---
    const ifcDir = pkgDir('web-ifc');
    for (const f of ['web-ifc-api.js', 'web-ifc.wasm', 'web-ifc-mt.wasm', 'web-ifc-mt.worker.js']) {
        await copy(path.join(ifcDir, f), path.join(OUT, 'web-ifc', f));
    }

    // --- three-mesh-bvh: готовый ESM-бандл, three снаружи ---
    await copy(
        path.join(pkgDir('three-mesh-bvh'), 'build', 'index.module.js'),
        path.join(OUT, 'three-mesh-bvh', 'index.module.js')
    );

    // --- supabase: UMD-сборка, грузится тегом <script> в <head> ---
    await copy(
        path.join(pkgDir('@supabase/supabase-js'), 'dist', 'umd', 'supabase.js'),
        path.join(OUT, 'supabase-js', 'supabase.js')
    );

    // --- jszip: чтение и запись .bcfzip, подключается по требованию ---
    await copy(
        path.join(pkgDir('jszip'), 'dist', 'jszip.min.js'),
        path.join(OUT, 'jszip', 'jszip.min.js')
    );

    // --- dwgdxf: DWG → DXF в браузере (движок acadrust, MIT) ---
    // Загрузчик ищет wasm по `new URL('./wasm', import.meta.url)`, поэтому
    // раскладку dist/ надо сохранить: index.js и рядом каталог wasm/.
    const dwgDist = path.join(pkgDir('dwgdxf'), 'dist');
    await copy(path.join(dwgDist, 'index.js'), path.join(OUT, 'dwgdxf', 'index.js'));
    for (const f of ['dwgdxf.js', 'dwgdxf_bg.wasm']) {
        await copy(path.join(dwgDist, 'wasm', f), path.join(OUT, 'dwgdxf', 'wasm', f));
    }

    // --- geotiff: тянет pako/lerc/zstddec, поэтому бандлим ---
    await build({
        entryPoints: [require.resolve('geotiff')],
        outfile: path.join(OUT, 'geotiff', 'geotiff.js'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2020',
        minify: true,
        legalComments: 'inline'
    });

    // --- qrcode: подключается тегом <script>, нужен глобальный QRCode ---
    // Входная точка — lib/browser.js: main тянет pngjs и node-модули fs/stream.
    await build({
        entryPoints: [path.join(pkgDir('qrcode'), 'lib', 'browser.js')],
        outfile: path.join(OUT, 'qrcode', 'qrcode.min.js'),
        bundle: true,
        format: 'iife',
        globalName: 'QRCode',
        platform: 'browser',
        target: 'es2020',
        minify: true,
        legalComments: 'inline',
        define: { 'process.env.NODE_ENV': '"production"' }
    });

    await vendorFonts();

    const versions = {};
    for (const p of ['three', 'three-mesh-bvh', 'web-ifc', 'geotiff', 'qrcode', '@supabase/supabase-js', 'jszip', 'dwgdxf']) {
        versions[p] = await pkgVersion(p);
    }
    await fs.writeFile(
        path.join(OUT, 'VERSIONS.json'),
        JSON.stringify({ generatedBy: 'npm run vendor', packages: versions }, null, 2) + '\n'
    );

    console.log(`three: three.module.js + ${addonCount} файлов addons`);
    console.log('web-ifc, three-mesh-bvh, geotiff, qrcode, шрифты — готово');
    console.log(`Версии: ${JSON.stringify(versions)}`);
}

/** Наборы шрифтов: у вьювера свой, у лендинга свой. Файлы .woff2 общие. */
const FONT_SETS = {
    'composer.css':
        'https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
    'site.css':
        'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&family=Syne:wght@600;700;800&display=swap'
};
/** css2 отдаёт woff2 только «современному» UA, иначе приедет ttf вдвое тяжелее. */
const MODERN_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function vendorFonts() {
    const dir = path.join(OUT, 'fonts');
    await fs.mkdir(dir, { recursive: true });
    const fetched = new Set();

    for (const [name, cssUrl] of Object.entries(FONT_SETS)) {
        const res = await fetch(cssUrl, { headers: { 'User-Agent': MODERN_UA } });
        if (!res.ok) throw new Error(`Google Fonts CSS ${name}: HTTP ${res.status}`);
        let css = await res.text();

        const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]))];
        for (const url of urls) {
            const file = path.basename(new URL(url).pathname);
            if (!fetched.has(file)) {
                const bin = await fetch(url, { headers: { 'User-Agent': MODERN_UA } });
                if (!bin.ok) throw new Error(`Файл шрифта ${file}: HTTP ${bin.status}`);
                await fs.writeFile(path.join(dir, file), Buffer.from(await bin.arrayBuffer()));
                fetched.add(file);
            }
            css = css.split(url).join(`./${file}`);
        }
        await fs.writeFile(path.join(dir, name), css);
    }
    console.log(`шрифты: ${fetched.size} файлов, наборов ${Object.keys(FONT_SETS).length}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
