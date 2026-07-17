# ya-proxy — CORS-прокси скачивания Яндекс.Диска

Браузер с GitHub Pages не может читать `downloader.disk.yandex.ru`: при запросе с `Origin` Яндекс отвечает **403** без `Access-Control-Allow-Origin`.

Эта Edge Function качает файл **на сервере** (без Origin) и отдаёт клиенту с `Access-Control-Allow-Origin: *`.

## Деплой (Supabase Dashboard)

1. [Edge Functions](https://supabase.com/dashboard/project/lgpzlvdviwieqkzkhebt/functions) → **Deploy a new function** → имя `ya-proxy`
2. Вставьте код из `index.ts`
3. В настройках функции отключите **Verify JWT** (`verify_jwt = false`), либо оставьте и передавайте anon key (клиент уже передаёт `apikey`)
4. В `auth-config.js` поставьте `yaDownloadProxy: 'supabase'` (или `'auto'`)

## CLI

```bash
npx supabase login
npx supabase functions deploy ya-proxy --project-ref lgpzlvdviwieqkzkhebt --no-verify-jwt
```

По умолчанию приложение использует публичный `dokpub` и не требует деплоя этой функции.
