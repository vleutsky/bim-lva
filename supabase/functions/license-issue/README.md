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

## Развёртывание: по шагам

Займёт 15–20 минут. Нужен доступ владельца проекта Supabase и Node на своей
машине. Проект: `lgpzlvdviwieqkzkhebt` (виден в адресе дашборда).

---

### Шаг 1. Создать таблицы

Дашборд Supabase → слева **SQL Editor** → **New query**.

Открыть в репозитории `supabase/migrations/20260805120000_licenses.sql`,
скопировать целиком, вставить в редактор, нажать **Run** (или Ctrl+Enter).

Должно ответить `Success. No rows returned`. Скрипт можно запускать повторно —
он написан через `create table if not exists` и `drop policy if exists`.

Проверить: слева **Table Editor** → в списке появились `license_admins`,
`license_requests`, `licenses`. У каждой в колонке RLS должно стоять
**Enabled**. Если нет — миграция выполнилась не полностью, посмотрите текст
ошибки в SQL Editor.

---

### Шаг 2. Зарегистрироваться на сайте

**До** следующего шага откройте `cabinet.html` на сайте и заведите аккаунт на
свою почту (или войдите, если он уже есть).

Это не формальность: следующий запрос ищет вас в `auth.users`, а строка там
появляется только после регистрации. Самая частая ошибка на этом месте —
`INSERT 0 0`, то есть «добавлено ноль строк», именно потому что пользователя
ещё нет.

---

### Шаг 3. Назначить себя админом

SQL Editor → New query. Подставьте свою почту — **ту же, что при регистрации**:

```sql
insert into public.license_admins (user_id, email)
select id, email from auth.users where email = 'вы@пример.ru'
on conflict (user_id) do nothing;
```

Ответ должен быть `Success. 1 row affected`. Если `0 rows` — почта не совпала;
посмотрите точное написание:

```sql
select id, email, created_at from auth.users order by created_at desc limit 10;
```

---

### Шаг 4. Сгенерировать ключи подписи

**На своей машине**, не в облаке и не в чужой сессии. Два способа, результат
одинаковый — выбирайте тот, где меньше возни.

**Если есть Node и репозиторий:**

```
node tools/make-license-keys.mjs
```

**Без установки чего-либо** — через консоль браузера. Откройте свой сайт
(любую страницу по https, на `about:blank` не сработает — Web Crypto требует
защищённый контекст), нажмите F12 → Console и вставьте:

```js
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
console.log('LICENSE_SIGNING_KEY=' + b64(await crypto.subtle.exportKey('pkcs8', kp.privateKey)));
console.log('публичный raw32 = ' + b64(new Uint8Array(spki).slice(-32).buffer));
```

Ключи рождаются в вашем браузере и никуда не отправляются. После того как
скопируете — закройте вкладку и очистите консоль.

Выведет три вещи:

| что | куда |
|---|---|
| `LICENSE_SIGNING_KEY=...` | в секреты Supabase, шаг 5 |
| SPKI base64 | если будете проверять через OpenSSL |
| **raw 32 байта base64** | в плагины, в константу `PublicKeyBase64` |

Приватный ключ **не коммитить, не пересылать, не вставлять в переписку**. Кто им
владеет — тот выписывает лицензии. Сохраните его в менеджере паролей: если
потеряете, придётся генерировать новую пару, а все ранее выданные ключи
перестанут подходить к плагинам со старым публичным ключом.

---

### Шаг 5. Положить приватный ключ в секреты

Дашборд → **Edge Functions** → вкладка **Secrets** → **Add new secret**.

| Name | Value |
|---|---|
| `LICENSE_SIGNING_KEY` | строка после `LICENSE_SIGNING_KEY=` из шага 4 |
| `LICENSE_ISSUER` | необязательно, например `BIM.LVA` |

Вставляйте **только само значение**, без имени переменной и без кавычек.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` и `SUPABASE_SERVICE_ROLE_KEY` добавлять не
нужно — Supabase подставляет их в функции сам.

---

### Шаг 6. Развернуть функцию

Функция состоит из двух файлов: `index.ts` и `license-format.js` рядом с ним.
Второй нужен потому, что тот же формат ключа используется в тестах — так выпуск
и проверка не могут разойтись.

**Через CLI — надёжный путь.** Установить один раз:

```
npm install -g supabase
supabase login
supabase link --project-ref lgpzlvdviwieqkzkhebt
```

Дальше из корня репозитория:

```
supabase functions deploy license-issue
```

CLI сам заберёт оба файла из `supabase/functions/license-issue/` и прочитает
`config.toml` рядом с ними.

**Через дашборд — без установки CLI.** В репозитории лежит
`supabase/functions/license-issue/bundled.ts`: та же функция, но одним файлом —
модуль формата вклеен в неё скриптом `npm run edge-bundle`, а не руками.

Edge Functions → **Create function** → имя ровно `license-issue` → удалить
содержимое редактора → вставить `bundled.ts` целиком → **Deploy**.

Тест `npm run test-license` сверяет сборку с исходниками: ключ из неё должен
получаться байт в байт таким же. Правьте всегда исходники и пересобирайте —
`bundled.ts` затирается при каждой сборке.

`verify_jwt` оставьте включённым. Функция всё равно проверяет вызывающего сама,
но пусть неавторизованные запросы отсекаются раньше, до вашего кода.

---

### Шаг 7. Проверить, что всё работает

1. Откройте `cabinet.html`, войдите. В разделе **Лицензии** отправьте заявку на
   любой продукт — на себя.
2. Обновите страницу: в шапке кабинета появилась кнопка **Выпуск лицензий**.
   Если её нет — шаг 3 не сработал, вернитесь к нему.
3. Откройте её. Ваша заявка должна быть в списке.
4. Нажмите **Выдать ключ**. Ключ появится прямо в карточке и в кабинете
   пользователя.
5. Скопируйте ключ и убедитесь, что он начинается на `BIMLVA1.` и состоит из
   трёх частей через точку.

---

### Если что-то не сходится

| Что видите | В чём дело |
|---|---|
| `LICENSE_SIGNING_KEY не задан в секретах функции` | Шаг 5: секрет не сохранён или назван иначе. После добавления секрета функцию надо развернуть заново. |
| `Недостаточно прав` | Вас нет в `license_admins`. Шаг 3 — проверьте, что почта совпала. |
| `Нужен вход` / `Недействительный токен` | Сессия истекла. Выйдите и войдите заново в кабинете. |
| Кнопки «Выпуск лицензий» нет в кабинете | Не выполнен шаг 3 либо не применилась политика `license_admins_select_self` — перезапустите миграцию. |
| `Заявка на этот продукт уже отправлена` | Так и задумано: одна открытая заявка на продукт. Старую надо выдать или отклонить. |
| `Failed to send a request to the Edge Function` | Функция не развёрнута или названа иначе. Имя должно быть ровно `license-issue`. |
| В списке заявок пусто, хотя заявка есть | Вы смотрите под другим аккаунтом — RLS покажет чужие заявки только админу. |

Логи функции: Дашборд → Edge Functions → `license-issue` → вкладка **Logs**.
Там видно и текст ошибки, и код ответа.

---

### Что делать дальше

Публичный ключ из шага 4 вставить в плагины — см. раздел «Проверка в плагине»
ниже. До этого момента ключи выдаются, но плагины их ещё не проверяют.

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
