/**
 * Локальный просмотр сайта: npm run serve  (порт можно задать: npm run serve -- 3000)
 *
 * Нужен, потому что вьювер не открывается двойным щелчком по файлу — ES-модули,
 * importmap и wasm требуют HTTP.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startStaticServer } from './static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8080;

const { port } = await startStaticServer(ROOT, PORT);

console.log(`Вьювер:  http://127.0.0.1:${port}/bim-lva-composer-ifc.html`);
console.log(`Лендинг: http://127.0.0.1:${port}/`);
console.log('');
console.log('Если открывали сайт раньше — обновите с Ctrl+Shift+R: старый');
console.log('service worker может отдать страницу из кэша.');
console.log('');
console.log('Ctrl+C — остановить.');
