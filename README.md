# Content Factory V1.2 — подготовка к запуску

Система управления собственными аккаунтами Threads через Telegram. TypeScript, Node.js 22 LTS, Fastify, grammY, PostgreSQL/Prisma, Redis/BullMQ и Playwright/CDP.

Рабочий демонстрационный режим запускается без Telegram-токена, ИИ-ключа, PostgreSQL и Redis. В нём используются 10 искусственных аккаунтов, 140 тестовых публикаций и явно обозначенные синтетические метрики. Состояние сохраняется в `.local/demo-state.json`. Демогенератор выдаёт фиксированный русский тестовый текст и **не является переводчиком**.

Реальные внешние интеграции требуют настройки и отдельной приёмки. Публикация на реальном Threads-аккаунте в этой поставке не подтверждалась. Селекторы интерфейса необходимо проверить на вашем авторизованном профиле. Подробности и границы проверки: [docs/PRELAUNCH_REPORT.md](docs/PRELAUNCH_REPORT.md).

Актуальная итерация: [отчёт перед запуском](docs/PRELAUNCH_REPORT.md). По умолчанию DRY_RUN; реальный запуск — отдельный этап.

Основной режим — отдельный исходник каждому аккаунту; BROADCAST поддерживает общий текст и пакет по стилям. Цель цикла — 120 минут, для десяти аккаунтов слоты по 12 минут и 12 минут резерва в конце окна. CTA индивидуальны; Telegram-атрибуция ведётся только по аккаунту. Правила и миграция: [обновление V1.1](docs/UPDATE_V1_1.md).

## Быстрый запуск демонстрации

Установите Node.js 22.15+ LTS и npm. Затем:

```bash
npm ci
npx playwright install chromium
npm run check
npm run demo
```

В текущем рабочем каталоге также подготовлен локальный Node.js для macOS ARM64. Запуск без системной установки: `./scripts/run-local.sh` (демо), `./scripts/run-local.sh node scripts/demo-client.mjs /start` (клиент). Этот локальный runtime исключён из Git.

В другом терминале:

```bash
node scripts/demo-client.mjs /start
node scripts/demo-client.mjs 'callback:analytics'
node scripts/demo-client.mjs 'Keep risk under control.'
```

Клиент выводит тексты сообщений и значения callback-кнопок. Используйте показанные значения для следующего действия:

```bash
node scripts/demo-client.mjs 'callback:rights:OWN:ID_МАТЕРИАЛА'
node scripts/demo-client.mjs 'callback:select:demo-account-1'
node scripts/demo-client.mjs 'callback:generate_selected'
node scripts/demo-client.mjs 'callback:approve'
node scripts/demo-client.mjs 'callback:queue'
```

Демопубликация выполняется mock-исполнителем; ссылки вида `/post/demo-...` искусственные. Расписание настоящее: выбранные аккаунты равномерно распределяются по целевому окну 120 минут. Деморежим поддерживает один процесс; для нескольких процессов используйте PostgreSQL и Redis.

При наличии `.env` клиент читает его автоматически. Если `.env` нет, локальный API использует `demo-local-token`. Демосервер слушает только `127.0.0.1:3000`.

## Реальное окружение

```bash
cp .env.example .env
# Отредактируйте .env: APP_MODE=production, токен бота, allowlist,
# два разных случайных секрета, пароль БД, браузер и LLM.
docker compose up -d
npm ci
npm run db:migrate
npm run db:seed
npm run check
npm run start
```

В `DATABASE_URL` и `POSTGRES_PASSWORD` должен быть один пароль; специальные символы в URL кодируются. `db:seed` создаёт только четыре стилевых профиля. Реальные аккаунты добавляются в боте и по умолчанию приостановлены.

`PROCESS_ROLE=all` запускает бот, внутренний HTTP API, планировщик, исполнителя и сборщик метрик. Для раздельных процессов задайте `PROCESS_ROLE=api` первому и `PROCESS_ROLE=worker` второму (или `npm run worker`). Только один процесс должен выполнять Telegram long polling. На одном сервере все процессы должны иметь одинаковые значения лимита браузеров и интервала.

## Проверки и команды

```bash
npm run typecheck
npm test
npm run test:browser
npm run build
npm run check
npm audit
```

Тесты включают настоящий Chromium с локальной фикстурой интерфейса и выполнение SQL-миграции в PostgreSQL-совместимом движке PGlite. Они не обращаются к Threads или платным API. Дополнительный интеграционный тест Prisma/BullMQ запускается при заданных `TEST_DATABASE_URL` и `TEST_REDIS_URL`. Он создаёт отдельную случайную SQL-схему и очередь и удаляет только их; используйте отдельные тестовые экземпляры сервисов. В CI эти зависимости запускаются автоматически. Для Linux перед тестами: `npx playwright install --with-deps chromium`.

Обновление:

```bash
node scripts/backup.mjs
# Получите новую версию исходников вашим способом доставки.
npm ci
npm run db:migrate
npm run check
sudo systemctl restart content-factory
```

При обновлении выполните все три миграции: старые снимки CTA, события и сохранённые расписания сохраняются. Перед реальным запуском проверьте персональные CTA и постоянные ссылки.

Не обновляйте селекторы на работающем заводе: сначала приостановите его и проверьте отдельный тестовый аккаунт.

## Модули

| Каталог          | Ответственность                                                    |
| ---------------- | ------------------------------------------------------------------ |
| `src/bot`        | Русскоязычное inline-меню, черновики, подтверждение, команды       |
| `src/accounts`   | Аккаунты, назначения профилей и стилей, проверки                   |
| `src/browser`    | AdsPower, Dolphin, Mock, Playwright/CDP                            |
| `src/content`    | Библиотека, X API, LLM, версии, проверки, бюджет                   |
| `src/scheduler`  | Расписание, BullMQ, блокировки, состояния отправки, восстановление |
| `src/analytics`  | Insights, исторические снимки, отчёты, рейтинги, CSV               |
| `src/tracking`   | Redirect, хешированные клики, Telegram-вступления и атрибуция      |
| `src/monitoring` | Ресурсы, состояние зависимостей, расходы                           |
| `src/http`       | Закрытый API и публичный redirect                                  |
| `prisma`         | 31 таблица, внешние ключи, индексы, SQL-ограничения                |

Инструкции: [Telegram](docs/TELEGRAM.md), [браузеры](docs/BROWSERS.md), [ИИ и источники](docs/AI.md), [аналитика и атрибуция](docs/ANALYTICS.md), [Ubuntu и восстановление](docs/DEPLOYMENT.md), [внутренний API](docs/API.md).

Локальная диагностика без БД/браузера/LLM и сетевых вызовов: `npm run dry-run -- OK saved-profile-Threads-02`.

Шаблоны Threads и «Качество генераций» доступны из главного меню. CTA можно включать/отключать; ожидающая задача фиксирует текущую версию при первом старте. Реальные профили не запускаются при BROWSER_EXECUTION_MODE=DRY_RUN.
