# Лицензии BIM.LVA

Заявка приходит из личного кабинета, ключ выпускает Edge Function, плагин
проверяет подпись сам — без интернета.

## Почему генератор не может жить на сайте

`vleutsky.github.io` отдаёт статику: любой файл оттуда скачивается целиком.
Генератор ключей в браузере означал бы, что секрет подписи уезжает каждому
посетителю и любой выпишет себе лицензию. Пароль на такую страницу ничего не
меняет — страница уже у него на диске.

Поэтому подписывает только Edge Function. Страница `license-admin.html` лежит
на сайте открыто и это безопасно: она лишь показывает заявки и просит сервер
выдать ключ, а сервер заново проверяет, кто пришёл.

По той же причине `adminEmails` в `auth-config.js` — не защита, а подсказка
интерфейсу. Настоящий список админов лежит в `public.license_admins`.

## Развёртывание

**1. Таблицы.** Supabase → SQL Editor → выполнить
`supabase/migrations/20260805120000_licenses.sql`.

**2. Назначить себя админом:**

```sql
insert into public.license_admins (user_id, email)
select id, email from auth.users where email = 'вы@пример.ru'
on conflict (user_id) do nothing;
```

**3. Ключи подписи** — на своей машине, не в облаке:

```
node tools/make-license-keys.mjs
```

Приватный (`LICENSE_SIGNING_KEY`) — в Supabase → Edge Functions → Secrets.
Публичный — в плагины. **Приватный не коммитить и никому не отдавать:** кто им
владеет, тот выпускает лицензии.

**4. Функция.** Supabase → Edge Functions → Create function `license-issue` →
вставить `index.ts` и `license-format.js` → Deploy. `verify_jwt` оставить
включённым.

**5. Проверка.** Войти в кабинет, отправить заявку на себя, открыть
`license-admin.html`, выдать ключ. Он появится в кабинете у пользователя.

## Формат ключа

```
BIMLVA1.<payload base64url>.<подпись Ed25519 base64url>
```

Подпись считается по байтам строки `BIMLVA1.<payload>` — плагин проверяет ровно
то, что видит, не пересобирая JSON. Payload:

| поле | смысл |
|---|---|
| `v` | версия формата, сейчас 1 |
| `id` | идентификатор лицензии (он же в базе) |
| `p` | код продукта, например `ksi-mapper` |
| `e` | email владельца |
| `o` | организация |
| `iss` | кто выпустил |
| `iat` / `exp` | выдана / действует до, Unix-время |

Длина — около 350 символов, копируется одним куском.

## Проверка в плагине (C#)

.NET до 10-й версии не умеет Ed25519 сам, поэтому нужен BouncyCastle:
`Install-Package BouncyCastle.Cryptography`. Работает и на .NET Framework 4.8,
на котором живут плагины Civil 3D и Navisworks.

Публичный ключ вшивается в сборку. Прятать его не нужно и невозможно — он
только проверяет, подписывать им нельзя.

```csharp
using System;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

public sealed class LicenseInfo
{
    public string Product { get; set; }
    public string Email { get; set; }
    public string Org { get; set; }
    public DateTime ExpiresUtc { get; set; }
}

public static class BimLvaLicense
{
    // «raw 32 байта (base64)» из вывода make-license-keys.mjs
    private const string PublicKeyBase64 = "ВСТАВЬТЕ_ПУБЛИЧНЫЙ_КЛЮЧ";

    public static bool TryVerify(string key, out LicenseInfo info, out string error)
    {
        info = null;
        error = null;

        var parts = (key ?? "").Trim().Split('.');
        if (parts.Length != 3 || parts[0] != "BIMLVA1")
        {
            error = "Это не похоже на ключ BIM.LVA.";
            return false;
        }

        var signed = Encoding.UTF8.GetBytes(parts[0] + "." + parts[1]);
        var signature = FromBase64Url(parts[2]);

        var verifier = new Ed25519Signer();
        verifier.Init(false, new Ed25519PublicKeyParameters(Convert.FromBase64String(PublicKeyBase64), 0));
        verifier.BlockUpdate(signed, 0, signed.Length);
        if (!verifier.VerifySignature(signature))
        {
            error = "Подпись не совпала — ключ повреждён или подделан.";
            return false;
        }

        using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(FromBase64Url(parts[1])));
        var root = doc.RootElement;
        var expires = DateTimeOffset.FromUnixTimeSeconds(root.GetProperty("exp").GetInt64()).UtcDateTime;
        if (DateTime.UtcNow > expires)
        {
            error = $"Срок лицензии истёк {expires:dd.MM.yyyy}.";
            return false;
        }

        info = new LicenseInfo
        {
            Product = root.GetProperty("p").GetString(),
            Email = root.GetProperty("e").GetString(),
            Org = root.TryGetProperty("o", out var o) ? o.GetString() : "",
            ExpiresUtc = expires
        };
        return true;
    }

    private static byte[] FromBase64Url(string value)
    {
        var s = value.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4)
        {
            case 2: s += "=="; break;
            case 3: s += "="; break;
        }
        return Convert.FromBase64String(s);
    }
}
```

Проверьте ещё, что `info.Product` — это тот плагин, который запущен: иначе ключ
от одного продукта откроет все.

## Чего эта схема не умеет

**Отозвать выданный ключ до конца срока.** Проверка идёт офлайн, о кнопке
«Отозвать» плагин не узнает — отметка в базе нужна, чтобы вы понимали картину и
не продлевали. Отсюда правило: не выдавайте лицензии на десять лет. Год —
разумный срок, продлить дешевле, чем отозвать.

**Помешать поделиться ключом.** Привязки к машине нет сознательно: она ломается
при замене компьютера и добавляет вам поддержки. Ключ содержит email и
организацию — этого обычно достаточно, чтобы делиться им было неловко.

**Помешать сломать сам плагин.** Любую офлайн-проверку в .NET можно вырезать
декомпилятором. Это защита от случайного распространения, а не от целенаправленного
взлома; последнее без серверной проверки при каждом запуске не решается вообще.
