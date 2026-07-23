# Локальный ИИ в BIM.LVA — полная инструкция

Две версии Composer:

| Файл | Назначение |
|---|---|
| `bim-lva-composer-ifc.html` | **Стабильный** рабочий плагин (как раньше, без ИИ) |
| `bim-lva-composer-ai.html` | **Composer AI** — тот же функционал + локальный ИИ |

ИИ работает **только на вашем ПК**. Модель и данные IFC не уходят в облако (запросы на `127.0.0.1`).

---

## 0. Как это выглядит в жизни

1. Устанавливаете Node.js и Ollama  
2. Скачиваете модель (`ollama pull …`)  
3. Запускаете `ai-bridge` из папки репозитория  
4. Открываете **Composer AI** по адресу bridge  
5. Меню **Анализ → ИИ (локально)**

Стабильный Composer на GitHub Pages можно продолжать использовать как обычно.

---

## 1. Что умеет ИИ (пункты 1–6)

В панели чата ассистент:

1. Отвечает на вопросы по **сводке IFC** (классы, GlobalId, выделение)  
2. Помогает разбирать **коллизии / замечания** (текст, не геометрия)  
3. Готовит черновики под **чеклист / BCF**  
4. Кратко резюмирует контекст **сравнения / выделения**  
5. Поясняет **ведомость** «на пальцах» по текущему выделению  
6. Вызывает действия UI: выделить по GlobalId, isolate, показать всё, вписать в кадр, подставить черновик BCF  

> ИИ **не смотрит** 3D-mesh. Он работает с JSON-индексом, который Composer AI собирает из уже загруженной модели, и с tool-вызовами.

---

## 2. Что скачать и установить

### A. Node.js (LTS) — нужен для bridge

1. Сайт: https://nodejs.org  
2. Скачайте **LTS** (зелёная кнопка, не Current)  
3. Установите с галочками по умолчанию  
4. **Закройте и откройте** терминал / PowerShell заново  
5. Проверка:

```bash
node -v
npm -v
```

Ожидается что-то вроде `v20.x` / `v22.x`.

---

### B. Ollama — локальный runtime для LLM

1. Сайт: https://ollama.com/download  
2. Установите для Windows / macOS / Linux  
3. Запустите Ollama (Windows: иконка в трее)  
4. Проверка:

```bash
ollama --version
```

---

### C. Модель (веса, скачивается один раз)

| Ваш ПК | Команда | Комментарий |
|---|---|---|
| 8–16 ГБ RAM | `ollama pull llama3.2` | нормальный старт |
| 16+ ГБ / есть GPU | `ollama pull qwen2.5:14b` | лучше рассуждает |
| слабый ноутбук | `ollama pull llama3.2:1b` | быстрее, проще ответы |

```bash
ollama pull llama3.2
ollama list
```

Необязательный тест в терминале:

```bash
ollama run llama3.2
```

Выход из чата Ollama: `/bye`.

---

### D. Локальная копия репозитория BIM.LVA

ИИ **не работает** надёжно с чистого GitHub Pages (браузер блокирует HTTPS → localhost).

Нужна папка проекта на диске:

- `git clone …`, или  
- Code → Download ZIP на GitHub → распаковать.

В корне должны быть:

```text
bim-lva-composer-ifc.html    ← стабильный
bim-lva-composer-ai.html     ← версия с ИИ
ai-client.js
ai-bridge/server.mjs
ai-bridge/start.bat
ai-bridge/start.sh
AI-LOCAL.md                  ← эта инструкция
```

---

## 3. Запуск bridge (обязательно)

Bridge:

1. Раздаёт файлы Composer по `http://127.0.0.1:3847`  
2. Проксирует чат в Ollama (`11434`)

### Windows

Дважды кликните:

```text
ai-bridge\start.bat
```

или в PowerShell из **корня** репозитория:

```powershell
node ai-bridge\server.mjs
```

### macOS / Linux

```bash
chmod +x ai-bridge/start.sh
./ai-bridge/start.sh
```

или:

```bash
node ai-bridge/server.mjs
```

В консоли должно быть:

```text
UI (AI): http://127.0.0.1:3847/bim-lva-composer-ai.html
UI (stable): http://127.0.0.1:3847/bim-lva-composer-ifc.html
Health: http://127.0.0.1:3847/ai/health
```

**Окно bridge не закрывайте**, пока пользуетесь ИИ.

Проверка: откройте http://127.0.0.1:3847/ai/health  
Ожидается `"ok": true`, `"ollama": true` и список моделей.

---

## 4. Открыть Composer AI

Только так:

```text
http://127.0.0.1:3847/bim-lva-composer-ai.html
```

В HUD должно быть: `build: composer-ai-v1`.

Не открывайте для ИИ:

- `https://…github.io/...`  
- `file:///C:/...`

Стабильный плагин (без ИИ) по-прежнему:

- GitHub Pages / `bim-lva-composer-ifc.html`  
- или http://127.0.0.1:3847/bim-lva-composer-ifc.html

---

## 5. Как пользоваться

1. Загрузите IFC (**Локально** / Я.Диск)  
2. **Анализ → ИИ (локально)**  
3. **Проверить связь** — статус зелёный  
4. Выберите модель (если пусто — `llama3.2`)  
5. Примеры запросов:

- `Сколько элементов в индексе и какие IFC-классы чаще встречаются?`  
- `Выдели стены (IfcWall), если они есть в контексте`  
- `Сформулируй черновик BCF по текущему выделению`  
- `Кратко опиши, что сейчас выделено и что проверить дальше`

Кнопки-пресеты в панели: **Черновик BCF**, **Классы модели**.

Если модель вернула `actions`, Composer AI выполнит их (выделение, isolate, draft BCF и т.д.).

---

## 6. Архитектура

```text
[Composer AI в браузере]
   │  JSON-контекст модели + сообщение
   ▼
[ai-bridge :3847]  ──статика──► bim-lva-composer-ai.html
   │
   ▼
[Ollama :11434]  (llama3.2 / qwen / …)
   │
   ▼
текст + JSON actions
   │
   ▼
Composer AI исполняет tools
```

| Путь | Назначение |
|---|---|
| `bim-lva-composer-ai.html` | UI с панелью ИИ |
| `bim-lva-composer-ifc.html` | стабильный UI без ИИ |
| `ai-bridge/server.mjs` | HTTP bridge + proxy Ollama |
| `ai-bridge/start.bat` / `start.sh` | быстрый запуск |
| `ai-client.js` | клиент в браузере |
| `AI-LOCAL.md` | эта инструкция |

---

## 7. Переменные окружения (опционально)

Windows (cmd):

```bat
set BIMLVA_AI_PORT=3847
set OLLAMA_HOST=http://127.0.0.1:11434
set BIMLVA_AI_MODEL=llama3.2
node ai-bridge\server.mjs
```

macOS / Linux:

```bash
export BIMLVA_AI_PORT=3847
export OLLAMA_HOST=http://127.0.0.1:11434
export BIMLVA_AI_MODEL=llama3.2
node ai-bridge/server.mjs
```

---

## 8. Типичные проблемы

### `Bridge недоступен`
- не запущен `node ai-bridge/server.mjs`  
- открыли GitHub Pages вместо `http://127.0.0.1:3847/bim-lva-composer-ai.html`  
- порт 3847 занят → смените `BIMLVA_AI_PORT`

### `ollama: false` в `/ai/health`
- Ollama не запущена  
- модель не скачана: `ollama pull llama3.2`  
- другой порт Ollama → `OLLAMA_HOST`

### Ответа не видно, «Отправить» серая
- ответ появляется **под** вашими бежевыми сообщениями (белый пузырь)
- серая кнопка = идёт запрос; при первом запуске модели на CPU часто **1–3 минуты**
- в чате должно быть «Думаю…»; в окне bridge появятся строки `[ai/chat] →` / `←`
- если зависло дольше 3 минут — перезапустите bridge и Ollama, очистите чат и спросите снова коротко: `какие topClasses в контексте?`

### Node не находится после установки
- перезапустите терминал  
- на Windows проверьте, что Node добавлен в PATH  

### Антивирус / корп. сеть
- разрешите Node и Ollama на localhost  
- интернет нужен только для первого `ollama pull`

---

## 9. Безопасность

- Облачные API-ключи **не нужны**  
- Запросы по умолчанию не покидают ПК  
- Не доверяйте ИИ юр.экспертизе «вслепую» — подтверждайте коллизии/нормы инструментами Composer  
- Не вставляйте в чат пароли и секреты  

---

## 10. Чеклист «с нуля»

1. Установить Node.js LTS → `node -v`  
2. Установить Ollama → `ollama --version`  
3. `ollama pull llama3.2`  
4. Открыть папку репозитория  
5. `node ai-bridge/server.mjs` (или `start.bat` / `start.sh`)  
6. Открыть http://127.0.0.1:3847/bim-lva-composer-ai.html  
7. Загрузить IFC  
8. **Анализ → ИИ (локально)** → Проверить связь → спросить  

Стабильный плагин без ИИ: `bim-lva-composer-ifc.html` (Pages или тот же bridge).

---

## 11. Что можно добавить дальше

- native tool-calling Ollama (вместо JSON-блока в тексте)  
- более полный индекс Pset / storey  
- кнопка «Объясни коллизии» из отчёта clash  
- WebLLM fallback без установки Ollama (слабее)  
- desktop-обёртка (Tauri/Electron), чтобы не запускать bridge вручную  
