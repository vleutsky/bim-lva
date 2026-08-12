# Лицензии BIM.LVA

Заявка приходит из личного кабинета, Edge Function выпускает файл `license.lic`
в том формате, который **уже проверяют ваши плагины**, клиент кладёт его в
`%ProgramData%\LVA.BIM\`.

Контракт задан не здесь, а в репозитории `LvaBim`:

| файл | что задаёт |
|---|---|
| `LVA.BIM.Common/Licensing/LicenseModels.cs` | поля и каноническая строка для подписи |
| `LVA.BIM.Common/Licensing/LicenseGate.cs` | проверка: подпись, срок, привязка, продукт, отзыв |
| `Tools/New-LvaLicense.ps1` | как то же самое делается вручную в PowerShell |

Сайт — второй способ выпустить ту же лицензию. PowerShell-скрипт продолжает
работать и остаётся запасным путём.

## Почему генератор не может жить на самом сайте

`vleutsky.github.io` отдаёт статику: любой файл скачивается целиком. Генератор в
браузере означал бы, что приватный ключ уезжает каждому посетителю. Пароль на
такую страницу ничего не меняет — она уже у него на диске.

Подписывает только Edge Function. Страница `license-admin.html` лежит открыто и
это безопасно: она показывает заявки и просит сервер выдать лицензию, а сервер
заново проверяет, кто пришёл. По той же причине настоящий список админов лежит в
таблице `license_admins`, а не в открытом `auth-config.js`.

## Отдельный ключ, а не сертификат подписи кода

Сайт подписывает **своей** RSA-парой, а не сертификатом «LVA Code Signing».
Утечка ключа лицензий позволит выписывать лицензии — поправимо перевыпуском.
Утечка ключа подписи кода позволит выпускать сборки от вашего имени.

Поэтому `LicenseGate` в плагинах должен принимать **оба** публичных ключа:
старый `pubkey.cer` (лицензии, выданные PowerShell) и новый `pubkey-web.cer`.
Правка — ниже, в разделе «Что поменять в плагинах».

## Развёртывание

Шаги 1–3 (таблицы, регистрация, назначение админа) уже выполнены по первой
миграции `20260805120000_licenses.sql`.

### Шаг 4. Вторая миграция

SQL Editor → выполнить `20260806140000_licenses_lic_format.sql`. Добавляет
`machine_id`, разрешает бессрочные лицензии и ограничивает продукты теми, что
знает код: `Civil`, `Navis`, `Inventor`, `*`.

### Шаг 5. Ключи

На Windows удобнее PowerShell — он не требует ни Node, ни openssl:

```
.\tools\New-LvaWebKey.ps1 -Years 10
```

Через Node (нужен openssl — есть в составе Git for Windows):

```
node tools/make-license-keys.mjs 10
```

Оба кладут в `license-keys/` (каталог в `.gitignore`):

| файл | куда |
|---|---|
| `private-key.b64` | секрет `LICENSE_SIGNING_KEY` в Supabase, потом удалить файл |
| `pubkey-web.cer` | в `LVA.BIM.Common/Licensing/`, встроенным ресурсом |

### Шаг 6. Секрет

Edge Functions → Secrets → `LICENSE_SIGNING_KEY` = содержимое `private-key.b64`.
Только значение, без имени переменной и переводов строки.

Если секрет уже заведён под старую схему — замените значение: прежний ключ был
Ed25519, плагины такую подпись не понимают.

### Шаг 7. Функция

Взять `bundled.ts` (собирается `npm run edge-bundle`), вставить в
Edge Functions → Create function → имя ровно `license-issue` → Deploy.
`verify_jwt` оставить включённым.

Через CLI — обычные `index.ts` + `license-lic.js`, они и есть источник правды.

### Шаг 8. Проверка

Кабинет → Лицензии → продукт, организация, **код компьютера** → отправить.
Затем «Выпуск лицензий» → выдать → скачать `license.lic` → положить в
`%ProgramData%\LVA.BIM\` → запустить команду LVA в Civil 3D.

## Учёт лицензий, выданных офлайн

Лицензии из `Tools\New-LvaLicense.ps1` работают у клиентов, но в базе сайта их
нет: список «Выданные лицензии» пуст, хотя ключи выданы. Чтобы учёт совпадал с
реальностью, у функции есть действие `import`, а в кабинете — форма
**«Учесть выданный ключ (.lic)»**: выбрать файл (или вставить текст), при желании
указать почту получателя.

Что важно понимать про это действие:

- **подпись не проверяется, и это осознанно.** Офлайн-лицензии подписаны
  сертификатом «LVA Code Signing», публичной части которого на сервере нет.
  Проверять подпись веб-ключом бессмысленно — она и не должна им сходиться.
  Настоящую проверку делает `LicenseGate` у клиента;
- разбирается формат (`parseLicenseFile`): без `Payload`/`Signature`, без
  продуктов, с нечитаемой датой или мусором вместо `HostLock` файл не примут;
- продукт должен быть из `Civil` / `Navis` / `Inventor` / `*`, и один на строку;
- **аккаунт получателя не нужен** — требуется миграция
  `20260812180000_licenses_user_id_optional.sql`, которая снимает NOT NULL с
  `licenses.user_id`. Лицензия node-locked, она привязана к железу, а не к
  аккаунту, и заводить пользователю регистрацию ради строки в списке незачем.
  Если почта совпала с уже известной — строка привяжется, и ключ будет виден
  человеку в его кабинете;
- повторный импорт того же файла отбивается по `LicenseId` (409).

Импорт ничего не подписывает и новых лицензий не создаёт — только учитывает уже
существующие.

## Что поменять в плагинах

Две правки в `LvaBim`, обе небольшие.

### 1. Принимать два публичных ключа

Сейчас `LoadEmbeddedPublicKey()` берёт первый ресурс, чей путь заканчивается на
`pubkey.cer`, и проверяет только им. Нужно перебрать все встроенные сертификаты
и принять подпись, если сошёлся хоть один. Иначе лицензии с сайта не подойдут, а
замена ключа обесценит ранее выданные.

```csharp
private static bool VerifySignature(LicensePayload payload, string signatureBase64)
{
    byte[] data = Encoding.UTF8.GetBytes(payload.ToCanonicalString());
    byte[] signature;
    try { signature = Convert.FromBase64String(signatureBase64); }
    catch { return false; }

    // Ключей несколько: старый — для лицензий из New-LvaLicense.ps1,
    // новый — для тех, что выпускает сайт. Подходит любой.
    foreach (RSA rsa in LoadEmbeddedPublicKeys())
    {
        using (rsa)
        {
            try
            {
                if (rsa.VerifyData(data, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
                    return true;
            }
            catch { /* повреждённый ресурс не должен мешать проверке остальными */ }
        }
    }
    return false;
}

private static IEnumerable<RSA> LoadEmbeddedPublicKeys()
{
    Assembly asm = typeof(LicenseGate).Assembly;
    foreach (string name in asm.GetManifestResourceNames()
                               .Where(n => n.EndsWith(".cer", StringComparison.OrdinalIgnoreCase)))
    {
        RSA rsa = null;
        try
        {
            using (Stream stream = asm.GetManifestResourceStream(name))
            {
                var bytes = new byte[stream.Length];
                stream.Read(bytes, 0, bytes.Length);
                using (var cert = new X509Certificate2(bytes)) rsa = cert.GetRSAPublicKey();
            }
        }
        catch { rsa = null; }
        if (rsa != null) yield return rsa;
    }
}
```

`pubkey-web.cer` добавить в `LVA.BIM.Common.csproj` как `EmbeddedResource` —
рядом с существующим `pubkey.cer`.

### 2. Деление ленты на бесплатное и платное

Сейчас `RibbonCommandHandler.Execute` вызывает `LicenseGate.Check("Civil")` для
каждой кнопки: лицензия нужна всем 89 командам без исключения.

Флаг в атрибуте, по умолчанию `true` — забыть его на новой платной команде
нельзя, а бесплатность отмечается осознанно.

```csharp
public class LvaButtonAttribute : Attribute
{
    public string ButtonText { get; }
    public string CommandName { get; }
    public string IconCode { get; }
    public string Description { get; }
    /// <summary>false — команда работает без лицензии.</summary>
    public bool RequiresLicense { get; set; } = true;

    // конструктор без изменений
}
```

Пометка бесплатной команды:

```csharp
[LvaButton("Версия", "LVA_Version", "i", "Показать версию сборки", RequiresLicense = false)]
```

В обработчике проверка становится условной:

```csharp
public void Execute(object parameter)
{
    if (!(parameter is RibbonButton btn) || btn.CommandParameter == null) return;

    // Tag проставляется при сборке кнопки — быстрее и надёжнее, чем искать
    // атрибут по всем сборкам на каждый клик.
    bool isFree = btn.Tag is bool free && free;

    if (!isFree)
    {
        var license = LicenseGate.Check("Civil");
        if (!license.IsValid)
        {
            System.Windows.Forms.MessageBox.Show(license.ToDisplayMessage(), "LVA BIM — лицензия",
                System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Warning);
            return;
        }
    }
    Application.DocumentManager.MdiActiveDocument.SendStringToExecute(
        (string)btn.CommandParameter, true, false, false);
}
```

Там, где кнопка создаётся, добавить `btn.Tag = !attr.RequiresLicense;`. На
платных кнопках стоит показывать замок в подсказке — чтобы отказ не был
неожиданностью уже после клика.

## Что эта схема не умеет

**Мгновенно отозвать лицензию.** Проверка офлайн-первая. `LicenseGate` смотрит
`revoked.json` в репозитории `lva-license-status` при старте, но с таймаутом
1.5 секунды, и без сети просто не мешает офлайн-вердикту. Отзыв — это «погаснет
при следующем сетевом запуске». Отсюда правило: сроки в пределах года,
бессрочные — только когда действительно нужно.

**Помешать вырезать проверку.** Любую офлайн-проверку в .NET снимают
декомпилятором. Это защита от случайного распространения, не от целенаправленного
взлома.

**Посчитать рабочие места.** Лицензия привязана к одной машине через `HostLock`.
Честный подсчёт мест без серверной проверки при запуске не делается.
