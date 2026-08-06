/**
 * Генерирует отдельную пару ключей для выпуска лицензий с сайта.
 *
 *   node tools/make-license-keys.mjs [срок_лет]
 *
 * Почему отдельную, а не тот сертификат «LVA Code Signing», которым подписаны
 * DLL: чтобы приватный ключ подписи кода не уезжал в облако. Утечка ключа
 * лицензий позволит выписывать лицензии — неприятно, но поправимо перевыпуском.
 * Утечка ключа подписи кода позволит выпускать сборки от вашего имени.
 *
 * Что делать с результатом:
 *   private-key.b64  → секрет LICENSE_SIGNING_KEY в Supabase, больше никуда
 *   pubkey-web.cer   → в LVA.BIM.Common/Licensing/ как встроенный ресурс,
 *                      рядом с существующим pubkey.cer (старые лицензии
 *                      продолжают проверяться прежним ключом)
 *
 * Старые лицензии, подписанные сертификатом «LVA Code Signing», остаются
 * действительными: LicenseGate после правки проверяет обоими ключами.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YEARS = Math.min(30, Math.max(1, Number(process.argv[2]) || 10));

// Subject повторяет существующий сертификат по смыслу, но помечен как ключ
// выпуска лицензий — чтобы в хранилище их нельзя было перепутать.
const SUBJECT = '/O=LVA.BIM/OU=License Issuing/CN=LVA BIM License Signing (web)';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lva-keys-'));
const keyPem = path.join(tmp, 'key.pem');
const certPem = path.join(tmp, 'cert.pem');
const certDer = path.join(tmp, 'cert.der');
const keyDer = path.join(tmp, 'key.p8');

try {
    // RSA-3072: заметно прочнее 2048 и без заметной платы — подпись считается
    // раз в жизни лицензии, а проверка в плагине и так мгновенная.
    execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:3072', '-sha256',
        '-days', String(YEARS * 365),
        '-nodes',
        '-keyout', keyPem, '-out', certPem,
        '-subj', SUBJECT
    ], { stdio: 'pipe' });

    // LicenseGate читает сертификат через X509Certificate2 — ему нужен DER.
    execFileSync('openssl', ['x509', '-in', certPem, '-outform', 'DER', '-out', certDer], { stdio: 'pipe' });
    // Приватный ключ в PKCS#8 DER — в таком виде его принимает Web Crypto.
    execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', keyPem, '-outform', 'DER', '-out', keyDer], { stdio: 'pipe' });

    const outDir = path.join(ROOT, 'license-keys');
    await fs.mkdir(outDir, { recursive: true });

    const privB64 = (await fs.readFile(keyDer)).toString('base64');
    await fs.writeFile(path.join(outDir, 'private-key.b64'), privB64 + '\n');
    await fs.copyFile(certDer, path.join(outDir, 'pubkey-web.cer'));
    await fs.copyFile(certPem, path.join(outDir, 'pubkey-web.pem'));

    const fingerprint = execFileSync('openssl', ['x509', '-in', certPem, '-noout', '-fingerprint', '-sha256'])
        .toString().trim();

    console.log(`Готово. Файлы в ${path.relative(ROOT, outDir)}/\n`);
    console.log('  private-key.b64   → секрет LICENSE_SIGNING_KEY в Supabase');
    console.log('  pubkey-web.cer    → в LVA.BIM.Common/Licensing/, встроенным ресурсом');
    console.log('  pubkey-web.pem    → тот же ключ текстом, если понадобится');
    console.log(`\n  ${fingerprint}`);
    console.log(`  срок действия: ${YEARS} лет`);
    console.log('\nprivate-key.b64 не коммитить — каталог license-keys уже в .gitignore.');
    console.log('Скопируйте значение в секреты Supabase и удалите файл.');
} finally {
    await fs.rm(tmp, { recursive: true, force: true });
}
