# Миграции Supabase: как применять

CLI не нужен. Всё делается в дашборде: **SQL Editor → New query → вставить
текст файла → Run** (`Ctrl+Enter`).

Файлы применяются **по порядку номеров** — он в имени. Каждый написан так, что
повторный запуск безопасен: колонки добавляются через `if not exists`, политики
и ограничения сначала удаляются через `if exists`. Если не помните, что уже
применено, — просто примените заново, ничего не сломается.

| Файл | Что делает | Состояние |
|---|---|---|
| `20260720120000_viewer_usage_events.sql` | статистика вьювера | применена |
| `20260721120000_bcf_notebooks.sql` | BCF-блокноты | применена |
| `20260805120000_licenses.sql` | `license_admins`, `license_requests`, `licenses`, RLS | применена |
| `20260811120000_viewer_usage_events_name.sql` | имя в событиях статистики | применена |
| `20260806140000_licenses_lic_format.sql` | `machine_id`, бессрочные лицензии, список продуктов | применена (проверено 12.08.2026) |
| `20260812180000_licenses_user_id_optional.sql` | лицензия без аккаунта — для учёта офлайн-ключей | **нужно применить** |

---

## Шаг 0. Посмотреть, что уже применено

Не по памяти, а по факту. SQL Editor → выполнить:

```sql
select
  (select count(*) from information_schema.columns
     where table_schema='public' and table_name='licenses' and column_name='machine_id') as est_machine_id,
  (select is_nullable from information_schema.columns
     where table_schema='public' and table_name='licenses' and column_name='expires_at') as expires_at_nullable,
  (select is_nullable from information_schema.columns
     where table_schema='public' and table_name='licenses' and column_name='user_id') as user_id_nullable;
```

Как читать результат:

| Столбец | Значение | Что означает |
|---|---|---|
| `est_machine_id` | `0` | миграция `20260806140000` не применена |
| `est_machine_id` | `1` | применена |
| `expires_at_nullable` | `NO` → `YES` | она же: бессрочные лицензии разрешены |
| `user_id_nullable` | `NO` | миграция `20260812180000` не применена |
| `user_id_nullable` | `YES` | применена, учёт офлайн-лицензий возможен |

---

## Шаг 1. `20260806140000_licenses_lic_format.sql`

Приводит таблицы к формату файла `license.lic`:

- добавляет `machine_id` в `license_requests` и `licenses` (привязка к железу);
- снимает `NOT NULL` с `licenses.expires_at` — бессрочные лицензии;
- ограничивает `product` списком `Civil` / `Navis` / `Inventor` / `*`.

**Перед запуском**, если в таблицах уже есть строки, проверьте, что продукты в
них из этого списка — иначе ограничение не создастся:

```sql
select product, count(*) from public.license_requests group by product order by product;
select product, count(*) from public.licenses         group by product order by product;
```

Увидите что-то вроде `Plant3D` или `civil` строчными — сначала поправьте
значение в строке, потом применяйте миграцию.

Открыть файл `supabase/migrations/20260806140000_licenses_lic_format.sql`,
скопировать целиком, вставить в SQL Editor, Run. Ожидаемый ответ — `Success`.
Строки `NOTICE: … does not exist, skipping` — это норма: миграция сносит
ограничение перед созданием, а при первом запуске сносить нечего.

## Шаг 2. `20260812180000_licenses_user_id_optional.sql`

Нужна для формы **«Учесть выданный ключ (.lic)»**: лицензии, выданные офлайн
скриптом `Tools\New-LvaLicense.ps1`, работают у клиентов, но в базе сайта их
нет — список «Выданные лицензии» пуст. Раньше внести их было нельзя: колонка
`licenses.user_id` требовала аккаунт в кабинете, а лицензия привязана к железу,
а не к аккаунту, и получатель мог вообще не регистрироваться.

Миграция снимает `NOT NULL` с `licenses.user_id` — и всё, RLS не трогает.
Политика `licenses_select_own` уже пускает админа через `is_license_admin()`
независимо от `user_id`, а обычному пользователю строка с `NULL` не попадётся:
в SQL сравнение `null = uuid` даёт `null`, а не `true`. Дополнительно ничего
закрывать не нужно.

Выдача через сайт не меняется: там `user_id` берётся из заявки и остаётся
заполненным. Пусто он бывает только у импортированных лицензий.

Скопировать файл целиком → SQL Editor → Run.

## Шаг 3. Проверить результат

```sql
select column_name, is_nullable
from information_schema.columns
where table_schema='public' and table_name='licenses'
  and column_name in ('user_id','expires_at','machine_id')
order by column_name;
```

Ожидается:

```
 column_name | is_nullable
-------------+-------------
 expires_at  | YES
 machine_id  | NO
 user_id     | YES
```

`machine_id` = `NO` — так и надо: у колонки есть `default ''`, пустая строка
означает «лицензия без привязки к машине».

Политика чтения (миграция её не меняет, но убедиться, что она на месте, полезно):

```sql
select policyname, cmd, qual from pg_policies where tablename='licenses';
```

Ожидается одна строка `licenses_select_own` / `SELECT` с условием
`(user_id = auth.uid()) OR is_license_admin()`.

## Шаг 4. Обновить Edge Function

Миграция сама по себе форму импорта не включает: действие `import` живёт в
функции. Edge Functions → `license-issue` → вставить целиком свежий
`supabase/functions/license-issue/bundled.ts` (собирается `npm run edge-bundle`)
→ Deploy.

После этого: кабинет → **«Учесть выданный ключ (.lic)»** → выбрать файл → почта
получателя (необязательно) → «Учесть лицензию».

---

## Если что-то пошло не так

| Сообщение | Причина и что делать |
|---|---|
| `column "machine_id" of relation … already exists, skipping` | миграция уже применялась, это не ошибка |
| `policy … does not exist, skipping` | первый запуск, сносить было нечего — норма |
| `check constraint "licenses_product_known" is violated by some row` | в таблице лежит продукт вне списка `Civil`/`Navis`/`Inventor`/`*` — найдите его запросом из шага 1 и поправьте |
| `null value in column "user_id" … violates not-null constraint` при импорте `.lic` | не применена миграция `20260812180000` |
| `Неизвестное действие: import` в кабинете | в дашборде развёрнута **старая** версия функции: вставьте свежий `bundled.ts` и нажмите Deploy. Свежая версия в этой же ошибке перечисляет, что она умеет — если `import` в списке нет, значит код точно старый |
| `duplicate key value violates unique constraint "licenses_pkey"` | тот же файл импортируется второй раз — защита от двойного учёта |
| `permission denied for table licenses` | запрос выполняется не в SQL Editor, а от имени клиента; выпуск и импорт идут только через Edge Function |

## Как это проверено

Обе миграции прогнаны на живом PostgreSQL 16 в том же порядке, что выше, с
заглушками схемы `auth` (`auth.users`, `auth.uid()`), которые в Supabase есть
сами. Проверено:

- до `20260812180000` вставка лицензии без `user_id` отклоняется — то есть
  миграция действительно необходима, а не «на всякий случай»;
- после неё учитывается бессрочная лицензия без аккаунта
  (`expires_at is null`, `user_id is null`);
- строка с `user_id is null` не видна обычному пользователю и видна админу —
  то есть RLS действительно можно было не трогать;
- выдача через сайт по-прежнему пишет `user_id`;
- продукт вне списка (`Plant3D`) отклоняется и после миграций;
- повторное применение обеих миграций проходит без ошибок.
