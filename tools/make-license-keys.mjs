/**
 * Генерирует пару ключей Ed25519 для подписи лицензий.
 *
 *   node tools/make-license-keys.mjs
 *
 * Приватный ключ — в секреты Edge Function (LICENSE_SIGNING_KEY). В репозиторий
 * он не попадает никогда: кто им владеет, тот выписывает лицензии.
 * Публичный — в плагины, его прятать не нужно и невозможно.
 *
 * Смена пары обесценивает все ранее выданные ключи: плагины со старым публичным
 * ключом перестанут их принимать. Меняйте только при утечке приватного.
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
// SPKI целиком нужен .NET и OpenSSL; последние 32 байта — «сырой» ключ,
// его ждут libsodium и большинство JS-библиотек.
const spki = publicKey.export({ type: 'spki', format: 'der' });
const rawPub = spki.subarray(spki.length - 32);

console.log('=== ПРИВАТНЫЙ КЛЮЧ — в секреты Supabase, никуда больше ===');
console.log('LICENSE_SIGNING_KEY=' + priv);
console.log('');
console.log('=== ПУБЛИЧНЫЙ КЛЮЧ — в плагины ===');
console.log('SPKI (base64, для .NET / OpenSSL):');
console.log('  ' + spki.toString('base64'));
console.log('raw 32 байта (base64, для libsodium / JS):');
console.log('  ' + rawPub.toString('base64'));
console.log('raw 32 байта (hex):');
console.log('  ' + rawPub.toString('hex'));
console.log('');
console.log('Приватный ключ не коммитить. Утечка = любой выпишет себе лицензию.');
