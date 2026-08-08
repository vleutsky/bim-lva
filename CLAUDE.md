# BIM.LVA — рабочая память

Справочник по проекту: сюда складываем всё, что уже выяснили, чтобы не искать
второй раз. **Читать в начале каждой сессии и обновлять по ходу.** Если факт
добыт дорого (чтением чужого кода, замером, разбором ошибки) — ему место здесь.

Язык общения с владельцем — русский. Владелец: Владимир Леуцкий,
`vladimirl1985@gmail.com` (в GitHub — `vleutsky`).

---

## 1. Два репозитория

| Что | Где | Ветка |
|-----|-----|-------|
| Сайт + вьювер (статика, GitHub Pages) | `/home/user/bim-lva` → `vleutsky/bim-lva` | `main` |
| Плагины Civil 3D / Navisworks / Inventor (C#, приватный) | `/workspace/lvabim` → `vleutsky/LvaBim` | `master`, работа в `claude/license-web-and-free-commands` |

`LvaBim` подключается через `add_repo` (owner `vleutsky`, repo `LvaBim`) — клон
уже лежит в `/workspace/lvabim`, повторно клонировать не надо. У него **свой**
`CLAUDE.md` с деталями сборки плагинов — читать его, а не гадать.

Публичный адрес сайта: `https://vleutsky.github.io/bim-lva/`
Версия для hh (без коммерческих блоков): `.../portfolio.html`

---

## 2. Сайт: что где лежит

- `bim-lva-composer-ifc.html` — **канонический вьювер**, ~900 КБ, весь код в одном
  файле. Версия и сборка — в объекте `COMPOSER_ABOUT` (сейчас `2026.08.08`).
- `bim-lva-composer-ifc-preview.html` — генерируется (`npm run preview`), без
  регистрации service worker, с бейджем сборки. У Pages нет preview-URL для
  веток, поэтому правки проверяем через этот файл в `main`.
- `bim-lva-composer-ai.html` — версия с локальным Ollama. **Ещё на CDN**, вендоры
  и BVH туда не переносились.
- `index.html` → `portfolio.html` генерируется через `npm run portfolio`.
- `cabinet.html` — личный кабинет (заявка на лицензию), `license-admin.html` —
  панель выпуска, `licenses.js` — общий клиент.
- `assets/vendor/**` — самохостинг зависимостей, **коммитится**. Шага сборки при
  деплое нет и не должно появиться.
- `sw-composer.js` — service worker; при правках вьювера поднимать `CACHE`
  (сейчас `bimlva-composer-shell-v82`). Вендоры — cache-first, свой JS/CSS —
  network-first.
- `FEATURES.md` — трекер фич вьювера (пункты 1–29 закрыты).

Из витрины приложений **убраны и не возвращаются**: «LVA BIM Matrix Builder»,
«Clash Group Automator», «Plant 3D Data Link» — этих продуктов больше нет
(кода под них в `LvaBim` тоже не нашлось). Plant 3D остался только в списке
используемого ПО и в предложении разработки под заказ — как платформа, не как
готовый продукт. Карточки нумеруются подряд, `03…09`.

### Команды

```bash
npm run serve        # http://127.0.0.1:8080 — двойным щелчком файл не открыть
npm run smoke        # Chromium: загрузка IFC, пикинг, тосты, коллизии
npm run check-site   # заглушки, битые ссылки, пустые якоря
npm run test-license # 25 проверок формата license.lic (см. §4)
npm run vendor       # пересобрать assets/vendor после смены версий
npm run preview      # пересобрать preview-файл
npm run portfolio    # пересобрать portfolio.html
npm run edge-bundle  # пересобрать bundled.ts для дашборда Supabase
node tools/bench-pick.mjs [N]
```

Перед merge в `main` — `npm run smoke` и `npm run check-site`.

---

## 3. Сборка плагинов: VS Code, без Visual Studio

Владелец работает **в VS Code**, не в Visual Studio. Solution `LVA.BIM.slnx`
открывать нечем — собираем из терминала `dotnet` CLI (проекты SDK-style,
это штатный путь, а не обходной).

```powershell
dotnet build LVA.Civil.BIM\LVA.Civil.BIM.csproj -c Release
```

- TFM выбирается по установленным Civil: 2022–2024 → `net48` (`Libs\2022`),
  2025+ → `net8.0-windows` (`Libs\2026`). Нет Civil на машине — оба.
  Явно: `-p:CivilTfms=net48`, всегда оба: `-p:CivilDetect=false`.
- Сборка **сама разворачивает** бандл в
  `%APPDATA%\Autodesk\ApplicationPlugins\LVA.BIM.bundle`. Если Civil держит DLL —
  `-p:SkipBundleDeploy=true`.
- `net48` требует MSBuild из Build Tools; `net8.0-windows` собирается одним .NET SDK.
- Расширение: **C# Dev Kit** (в `.vscode/settings.json` уже
  `"dotnet.preferCSharpExtension": true`). `.vscode/tasks.json` содержит задачи
  `build`/`publish`/`watch`, но они нацелены на `LVA.Tests`, а не на плагин.
- Inventor **не в solution** — собирается отдельно своим csproj.
- Тесты: `dotnet run --project LVA.Tests` (140 проверок, без AutoCAD).
- DLL подписываются сертификатом «LVA Code Signing» (`Tools\Sign-LvaDll.ps1`),
  пропуск — `-p:SkipSign=true`.

---

## 4. Лицензии — контракт (единственный источник правды)

Формат придуман **не нами**: он уже реализован в
`LVA.BIM.Common\Licensing\` (`LicenseGate.cs`, `LicenseModels.cs`) и в
`Tools\New-LvaLicense.ps1`. Веб подстроен под него. **Ничего здесь не менять,
не сверившись с C#.**

- Алгоритм: **RSA-SHA256, PKCS#1 v1.5** (не Ed25519 — была такая ошибка).
- Продукты: ровно `Civil`, `Navis`, `Inventor`, `*`. Других нет.
- Привязка к железу: `HostLock` = SHA-256 от
  `Win32_ComputerSystemProduct.UUID` (Trim → UpperInvariant → UTF8 → hex X2),
  64 hex-знака. Клиент получает его через `Tools\Get-LvaMachineId.ps1`.
- Каноническая строка:
  `LicenseId|ClientName|Products(через запятую)|IssuedUtc|ExpiresUtc|HostLock`
  Бессрочная — пустая строка в позиции `ExpiresUtc`, не `null`.
- **Даты — .NET `ToString("o")`: семь знаков дробной части.** JS `toISOString()`
  даёт три, и подпись не сходится после разбора JSON в C#. Для этого есть
  `toDotNetRoundTrip()`; на это завязана половина `npm run test-license`.
- Файл `license.lic` = JSON `{ Payload, Signature }`.

Ключи:

- Ключ подписи **кода** («LVA Code Signing») остаётся офлайн, в облако не уезжает.
- Для веба — **отдельная** пара: `tools/New-LvaWebKey.ps1` (RSA-3072,
  `New-SelfSignedCertificate`; на PS 5.1 нужен openssl из Git for Windows).
  Приватная часть → секрет `LICENSE_SIGNING_KEY` в Supabase, `pubkey-web.cer` →
  в `LVA.BIM.Common\Licensing\` и пересборка. `LicenseGate.VerifySignature`
  перебирает **все** встроенные `.cer`, поэтому старые лицензии не ломаются.
- Приватный ключ генерируется **только на машине владельца**. В чат, в репозиторий
  и в коммиты он не попадает никогда. `license-keys/` в `.gitignore`.
- Статический сайт — **не защищённое место**. Генератор ключей в браузере
  опубликовал бы секрет. Выпуск живёт только в Edge Function под `service_role`.
- `adminEmails` в `auth-config.js` — удобство UI, **не** защита. Права решает
  таблица `license_admins`.

---

## 5. Supabase

Проект `lgpzlvdviwieqkzkhebt`. Publishable key лежит в `auth-config.js` открыто —
так и задумано.

Состояние:

- [x] миграция `20260805120000_licenses.sql` применена
      (`license_admins`, `license_requests`, `licenses`, RLS, `is_license_admin()`)
- [x] владелец добавлен в `license_admins`
      (`user_id 46427174-fff1-47a5-bfbb-ad1384472ae7`)
- [ ] миграция `20260806140000_licenses_lic_format.sql` — добавляет `machine_id`,
      снимает NOT NULL с `expires_at`, ограничивает `product`
- [ ] секрет `LICENSE_SIGNING_KEY` заменить: сейчас там **устаревший Ed25519**
- [ ] развернуть функцию `license-issue`

Развёртывание без CLI: вставить в редактор дашборда **`bundled.ts`** целиком
(генерируется `npm run edge-bundle`, руками не править). Через CLI —
обычные `index.ts` + `license-lic.js`, они источник правды.
Подробности — `supabase/functions/license-issue/README.md`.

---

## 6. Состав ленты Civil 3D (посчитано по исходникам)

9 вкладок, **88 команд** — цифры получены разбором всех `[LvaButton]` в
`LVA.Civil.BIM` с воспроизведением `SectionOf()` из `LVA_Ribbon.cs`. Осторожно:
объемлющий класс надо искать по балансу скобок, «последний `class` выше» уводит
команды не на ту вкладку; а `///`-пример в описании `LvaButtonAttribute`
добавляет фантомную 89-ю кнопку `LVA_Version`.

| Вкладка | Кнопок | Панели |
|---------|--------|--------|
| LVA · Генплан | 11 | «Генплан и Поверхности» + «Мой набор (генпланист)» |
| LVA · НВК | 40 | трубы · опоры и блоки · прокладка · проверки/данные · оформление |
| LVA · Свойства | 14 | «Свойства» |
| LVA · BIM/IFC | 4 | «BIM / IFC» |
| LVA · Конструктор | 2 | «Конструктор элементов» |
| LVA · Координация | 6 | «Координация Revit» |
| LVA · BIM Bridge | 5 | «BIM Bridge» |
| LVA · Электрика | 4 | «Кабели» (дубли кабельных команд) |
| LVA · Сети связи | 6 | «Кабели» + «Профиль / ГНБ» |

Кабельные команды генерические — одни и те же кнопки продублированы в
«Электрика» и «Сети связи» через `CustomPanels`. Есть ещё сборка
`Release_RTIP` (`#if RTIP_GENPLAN`) — одна вкладка «LVA · РТИП-Генплан».

Это же разложено на сайте в разделе `#ribbon` (`index.html`). Меняется лента —
править и там.

## 7. Платное и бесплатное на ленте

Механизм готов в `LVA.Civil.BIM/LVA_Ribbon.cs`:
`[LvaButton(..., RequiresLicense = false)]` → `Tag = "LVA_FREE"` → обработчик
пропускает проверку лицензии; в подсказке приписывается «Требуется лицензия.» /
«Работает без лицензии.».

Сейчас бесплатны только `LVA_Version` и `LVA_CatalogDoctor`. **Остальные 86
команд владелец ещё не разметил** — это открытый вопрос.

⚠️ `CatalogDoctor.cs` сохранён в **cp1251**, не в UTF-8. Правки — побайтно,
иначе побьются русские подписи кнопок.

---

## 8. Ограничения среды

- Прокси **блокирует** unpkg, jsdelivr, github.io, supabase.co. **Пропускает**
  registry.npmjs.org и fonts.googleapis.com. Отсюда вендоринг через npm-тарболлы
  и esbuild.
- .NET-компилятора в песочнице **нет**. Совместимость с C# доказываем
  воспроизведением логики в JS + сверкой (`tools/test-license.mjs`), а наличие
  API в `AdWindows.dll` — сканированием строк метаданных.
- `crypto.subtle` не работает на `about:blank` — нужен secure context,
  поэтому тесты гоняем через локальный `http://127.0.0.1`.
- Playwright: браузер уже стоит, `playwright install` не запускать.
  В `tools/smoke.mjs` есть `resolveChromium()` — обход несовпадения ревизий.

---

## 9. Грабли (уже наступали)

- **Не выдумывать состав продукта.** Список плагинов, кнопок и продуктов брать
  из кода `LvaBim`. Дважды придумывался несуществующий перечень — оба раза мимо.
- **Не проектировать поверх непрочитанного.** Схема лицензий была построена с
  нуля (Ed25519, привязка к email+организации), хотя в репозитории уже работала
  своя — RSA и node-lock. Переделывать пришлось целиком.
- Не завышать эффект в коммитах и в отчётах: писать измеренное число.
  (Коллизии — 5.2 с, а не «минуты»; блоки DXF — +26 % сущностей, а не «половина
  чертежа».)
- `git cherry-pick -q` такого флага не имеет; неудачный `checkout` оставил не на
  той ветке, и `--amend` переписал чужой коммит. Перед `--amend` проверять,
  где находишься. `git reset --hard` до этого съел незакоммиченные правки.
- Генераторы (`make-preview.mjs` и т.п.) не привязывать к точным строкам вроде
  `buildId: 'e552c86'` — только регулярки, иначе ломаются на смене версии.
- Тесты вьювера: `modelCount` растёт **до** появления геометрии. Ждать саму
  запись в `modelBounds`, иначе гонка.
- Во вьювере `esc`/`escAttr` объявлены в конце модуля. Код, выполняющийся при
  инициализации (IIFE, top-level), их звать не может — TDZ роняет весь модуль,
  и падает всё после точки ошибки. В обработчиках событий — можно.
- RVT не открыть в принципе — геометрия Revit закрыта, открытых реализаций нет.
  Файл распознаём и объясняем, что нужен экспорт в IFC.
- **`COORDINATE_TO_ORIGIN` ломает сводку.** web-ifc сдвигает им *каждый* файл к
  его собственному центру и не сообщает, на сколько (`GetCoordinationMatrix`
  возвращает нули — проверено). Включённый «для всех геодезических моделей», он
  схлопывал шесть файлов одной дороги в кучу у нуля; габариты при этом
  правильные, поэтому по ним поломка не видна. Включать только против float32-
  тесселяции CSG (много boolean). Без CSG вершины локальны, а мировое
  положение живёт в `flatTransformation` (double) — точность цела.
  Закреплено проверкой `checkGeoFederation` в `npm run smoke`.
- Схемы IFC4X1/IFC4X2 (Civil 3D, OpenRoads) web-ifc парсит нормально, хотя
  официально не заявляет: DATA-секция читается без оглядки на `FILE_SCHEMA`.
  Открываем их с предупреждением, а не отказом.

---

## 10. Хвосты

- Разметить остальные команды ленты на бесплатные/платные.
- Довести до конца развёртывание Supabase (§5) и выпустить тестовую лицензию.
- `bim-lva-composer-ai.html` перевести на локальные вендоры и BVH.
- Вендорить Tailwind для `case_inventor.html` и `plugin_ksi.html`.
- От владельца: картинка `img/plugin_main_screen.png`; подтвердить, работает ли
  `https://infrabim.pro/main` (тогда обновить http-ссылки).
