# ScheduleBot

Расписание группы П-61БС УрТИСИ СибГУТИ в Telegram. Mini App показывает учебный день, время до следующей пары, календарь и поиск. Бот отвечает на команды и принимает XLSX. Администратор проверяет черновик и публикует изменения без пересборки приложения. Все часы расписания и рассылок относятся к Екатеринбургу.

## Как устроен проект

| Путь | Назначение |
|---|---|
| `src/web/` | React, TypeScript, Vite, CSS и официальный Telegram Web App API |
| `src/excel/` | Ограниченная распаковка XLSX и разбор XML. На клиенте работает в отдельном Web Worker |
| `src/shared/` | Типы, поиск, расписание звонков, календарь и состояния учебного дня |
| `src/worker/` | REST API, Telegram webhook, авторизация, версии и рассылки |
| `migrations/` | Таблицы и транзакционный триггер Cloudflare D1 |
| `tests/` | Vitest, интеграция с локальным D1 в Miniflare и проверка настоящего XLSX |
| `.github/workflows/pages.yml` | Проверки и публикация frontend на GitHub Pages |
| `scripts/telegram.mjs` | Настройка webhook, команд и кнопки меню через Bot API |

Frontend читает расписание через REST API. Worker хранит его в D1. Публикация создаёт неизменяемый снимок в одной SQL-операции. Занятия внутри периода заменяются после подтверждения. Остальные даты сохраняются. Откат создаёт новую версию из выбранного снимка. Настройки режима звонков хранятся отдельно и применяются ко всем версиям.

## Локальный запуск на Windows 11

Установите Git и Node.js 24 LTS. В PowerShell выполните:

```powershell
git clone https://github.com/Pka564/ScheduleBot.git
Set-Location ScheduleBot
npm.cmd ci
npx.cmd wrangler d1 migrations apply schedulebot --local
npm.cmd run worker
```

Оставьте терминал открытым. Во втором PowerShell, из папки `ScheduleBot`:

```powershell
npm.cmd run dev
```

Откройте `http://localhost:5173/ScheduleBot/`. Vite перенаправляет `/api` на локальный Worker. В новом D1 приложение покажет, что расписание пока не опубликовано. Для проверки с реальным Telegram используйте развёрнутый Worker, GitHub Pages и отдельного тестового бота. Для локальной настройки секретов можно скопировать `.dev.vars.example` в `.dev.vars` и заполнить файл. Он исключён из Git.

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run build:worker
```

Чтобы включить тест реального вложения, сохраните его вне репозитория и укажите путь:

```powershell
$env:SCHEDULEBOT_TEST_XLSX = "$env:USERPROFILE\Downloads\P-61BS_30_11-19_12.xlsx"
npm.cmd test
Remove-Item Env:SCHEDULEBOT_TEST_XLSX
```

## Развёртывание на бесплатных тарифах

### Cloudflare D1 и Worker

1. Создайте аккаунт Cloudflare. В разделе **Workers & Pages** включите бесплатный адрес `workers.dev`.
2. В корне проекта войдите в аккаунт и создайте базу:

   ```powershell
   npx.cmd wrangler login
   npx.cmd wrangler d1 create schedulebot
   ```

3. Скопируйте выданный идентификатор в `database_id` в `wrangler.toml`. Значение `MINI_APP_URL` должно совпадать с будущим HTTPS-адресом Pages, включая путь `/ScheduleBot/`. Для исходного репозитория уже задан адрес `https://pka564.github.io/ScheduleBot/`.
4. Примените миграции и разверните Worker:

   ```powershell
   npx.cmd wrangler d1 migrations apply schedulebot --remote
   npm.cmd run deploy:worker
   $env:WORKER_URL = Read-Host "Скопируйте HTTPS-адрес Worker из вывода Wrangler"
   Invoke-RestMethod "$($env:WORKER_URL.TrimEnd('/'))/api/health"
   ```

### GitHub Pages

1. В GitHub откройте **Settings → Pages → Build and deployment → Source → GitHub Actions**. Бесплатная публикация Pages доступна для публичного репозитория.
2. В **Settings → Secrets and variables → Actions → Variables** создайте переменную `VITE_API_URL` со своим HTTPS-адресом Worker, без `/api`. Это публичный URL.
3. Запустите workflow **Проверка и GitHub Pages** на `main` или отправьте изменения в `main`. Публикация использует `dist` и базовый путь `/ScheduleBot/`. При другом имени репозитория измените путь в `vite.config.ts` и адрес в `wrangler.toml`.

### Telegram, секреты и кнопка «Расписание»

1. В Telegram откройте **@BotFather**, выполните `/newbot` и сохраните токен. В PowerShell загрузите токен, создайте секрет webhook и передайте их Worker:

   ```powershell
   $env:BOT_TOKEN = ([pscredential]::new('bot', (Read-Host 'Токен BotFather' -AsSecureString))).GetNetworkCredential().Password
   $env:TELEGRAM_WEBHOOK_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
   $env:MINI_APP_URL = 'https://pka564.github.io/ScheduleBot/'
   $env:BOT_TOKEN | npx.cmd wrangler secret put BOT_TOKEN
   $env:TELEGRAM_WEBHOOK_SECRET | npx.cmd wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npm.cmd run telegram:setup
   ```

   Скрипт регистрирует `POST /api/telegram`, команды и кнопку `web_app`. Если нужно задать кнопку вручную, используйте **@BotFather → /setmenubutton**, выберите бота, укажите адрес Pages и подпись «Расписание».

2. Отправьте боту `/start`, затем `/id`. Разрешите свой ID и при необходимости ID других администраторов через запятую:

   ```powershell
   (Read-Host 'Telegram ID администраторов через запятую') | npx.cmd wrangler secret put ADMIN_TELEGRAM_IDS
   Remove-Item Env:BOT_TOKEN, Env:TELEGRAM_WEBHOOK_SECRET
   ```

   Токен, webhook secret и список администраторов хранятся в Cloudflare Worker Secrets. `MINI_APP_URL` — обычная переменная Worker, совпадающая с адресом Pages. Frontend получает только публичный `VITE_API_URL`.

### Первая публикация расписания

1. В личном чате с ботом отправьте `P-61BS_30_11-19_12.xlsx` как документ. Нажмите **Разобрать Excel → Сформировать черновик**. Можно также загрузить файл напрямую через `/admin`.
2. Проверьте группу, период, новые и удаляемые строки, занятия по датам и предупреждения. Если год в файле отсутствует, задайте год первой даты периода.
3. Нажмите **Опубликовать → Подтвердить публикацию** в Mini App или в сообщении бота. После открытия расписания и возвращения в приложение данные обновятся с API.
4. Через `/admin` доступны история и откат, добавление групп и предпраздничный режим. В панели можно приостановить категории рассылок для группы. Пользовательские подписки меняются в настройках Mini App. Для доставки нужно отправить боту `/start`.

## Формат расписания

Приложенный пример — лист `П-61бс`, три горизонтальные недели, по четыре столбца на блок. Таблица содержит 18 заголовков учебных дней и 43 непустые записи: 17 лекций, 17 практик, 2 экзамена, 3 зачёта и 4 мероприятия. Из заголовка извлекается период 30.11.2026–19.12.2026. У собрания указано только начало в 09:00. Самоподготовка отмечена как событие без времени. Дистанционное обучение, установки и совместные занятия отражаются в примечаниях. Оригинал файла не хранится в репозитории.

Парсер ожидает блоки **дата / номер пары / дисциплина / аудитория**, в том числе при объединённой ячейке даты. Поддерживаются Excel-даты, текстовые даты, типовые сокращения и переход декабря в январь. Нераспознанные строки в обнаруженных блоках попадают в предупреждения с исходным текстом. XLSX ограничен 5 МиБ, заявленная суммарная распаковка — 32 МиБ, отдельная часть — 16 МиБ. Границы распаковки проверяются в клиенте. Worker принимает только прошедший серверную валидацию JSON до 360 КБ, не более 1000 записей на импорт.

## API

Публичные GET: `/api/health`, `/api/groups`, `/api/groups/{group}/schedule`, `/api/groups/{group}/version`, `/api/groups/{group}/search`. Для расписания доступны `date` или `from` и `to` в формате ISO, для поиска — `q` и `type`.

GET/PUT `/api/settings` и `/api/admin/*` принимают подписанный Telegram `initData` в заголовке `Authorization: tma …`. Для административных маршрутов также проверяется Telegram ID. Webhook принимает собственный секрет в заголовке Telegram. Публичный и защищённый API ограничены по частоте запросов.

## Уведомления и эксплуатационные ограничения

- Рассылки выключены по умолчанию. Cron запускается каждые 5 минут. Утренняя рассылка планируется с 07:00, вечерняя с 19:00. Напоминание ставится в очередь за 10–15 минут.
- За запуск отправляется до 12 сообщений. Очередь сохраняется в D1. При 429 учитывается задержка Telegram, при 403 получатель помечается как заблокировавший бота. При неизвестном результате доставки уведомление не повторяется, чтобы не создавать дубли.
- Лимиты рассчитаны на учебную группу. При нескольких группах Cron обходит их по очереди, поэтому короткие окна напоминаний могут пропускаться. Массовые рассылки потребуют пересмотра частоты, квот и очереди.
- Workers Free ограничивает CPU и число запросов, D1 Free — объём базы и суточные операции чтения/записи. Снимки версий занимают место, а частые запросы расходуют лимит. Актуальные значения смотрите в [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) и [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/). Разбор XLSX выполняется на устройстве администратора.
- Кэш хранит последний успешно полученный снимок и файлы интерфейса в браузере Telegram. Если браузер запрещает локальное хранилище или приложение открыто впервые без связи, сохранённого расписания может не быть.

## Обновление и диагностика

После изменения кода запустите проверки. Публикация в `main` запускает Pages. Для нового Worker примените новые миграции, затем выполните `npm.cmd run deploy:worker`. Регистрацию webhook повторяйте при смене URL или секрета.

### Обновление существующего Worker

В каталоге проекта проверьте, что в `wrangler.toml` указаны имя действующего Worker, привязка `DB` и ID уже созданной базы. Войдите в тот же аккаунт Cloudflare, затем выполните:

```powershell
npm.cmd ci
npx.cmd wrangler secret list --name schedulebot
npx.cmd wrangler deploy --keep-vars
npx.cmd wrangler tail --name schedulebot --format pretty
```

`secret list` показывает имена секретов. При развёртывании кода существующие секреты и данные D1 сохраняются. Ключ `--keep-vars` сохраняет переменные из панели Cloudflare, если их нет в конфигурации проекта. Для исправления webhook миграции и повторная регистрация webhook не нужны.

В личном чате отправьте боту новые команды `/start`, `/id` и `/admin`. По одному `trace` в Wrangler tail можно проследить прохождение запроса до `api_success` и `update_completed`. Команды `/start` и `/id` доступны до настройки `ADMIN_TELEGRAM_IDS`. Команда `/admin` в этом случае отвечает «Доступ запрещён».

| Событие в Wrangler tail | Значение |
|---|---|
| `webhook_rejected` | Сверьте наличие `BOT_TOKEN`, формат `TELEGRAM_WEBHOOK_SECRET` и секрет, переданный при регистрации webhook |
| `database_failed` | Поле `operation` показывает SQL-этап. Если это `register_user`, базовые команды отвечают даже при сбое регистрации |
| `menu_fallback` | Mini App URL или клавиатура отклонены. Проверьте `MINI_APP_URL` |
| `api_failure`, `reason: rejected`, код 401 | Telegram отклонил авторизацию. Проверьте `BOT_TOKEN` у действующего Worker |
| `api_failure`, `reason: redirect` | Telegram вернул 3xx. Запрос остановлен до перехода по ссылке с токеном |
| `api_failure`, `reason: type_error` | Runtime выбросил `TypeError` при обработке запроса или ответа |
| `api_failure`, `reason: timeout` или `network` | Истекло время ожидания или оборвалось соединение |
| `update_retry` | Обработка команды прервалась до отправки или Telegram явно ответил 429. Повторную доставку webhook можно обработать |
| `update_failed` | Повтор этой доставки подавлен. При сетевом сбое или нечитаемом ответе Telegram мог уже принять сообщение. После диагностики отправьте новую команду |

Логи приложения содержат этап, случайный идентификатор попытки и код ответа. В них не записываются токены, Telegram ID, тексты сообщений, адреса перенаправлений или исходные исключения. В тестах Miniflare запускает код Worker с настройками совместимости из `wrangler.toml`. Ответы Telegram для этих тестов подаёт локальный сервис.

| Симптом | Что проверить |
|---|---|
| Pages открывается, но расписание недоступно | URL в `VITE_API_URL`, `/api/health`, адрес Pages в `MINI_APP_URL` |
| Бот не отвечает | Токен, совпадение webhook secret, URL Worker, завершение `telegram:setup` |
| /admin отклоняет доступ | Числовой ID от `/id` в Worker Secret `ADMIN_TELEGRAM_IDS` |
| Черновик устарел | Импортируйте XLSX повторно и проверьте изменения относительно новой версии |
| Не распознаётся дата | Проверьте блоки столбцов и введите год начала периода |
| Worker не видит таблицы | Примените миграции с правильным `--local` или `--remote` |
