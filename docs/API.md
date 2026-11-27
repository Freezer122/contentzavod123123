# Внутренний HTTP API

В V1.5 `/api/queue` дополнительно возвращает `post_submit_at`, `post_confirmed_at`, `cta_scheduled_at`, `cta_submit_at`, `cta_confirmed_at`, `actual_interval_seconds` и `cta_lateness_seconds`. Неизвестные исторические значения — null. Даты сохраняются в UTC. Целевое время CTA — submit поста + 20 секунд, при обязательном подтверждении собственного permalink до отправки CTA. См. [отчёт hotfix](HOTFIX_V1_5_REPORT.md).

Все `/api/*` и `/health` требуют `Authorization: Bearer INTERNAL_API_TOKEN`. Слушайте loopback; публично проксируйте только `/r/`. `/live` возвращает только доступность процесса и признак деморежима. Размер тела ограничен 64 KiB, запросы — 120 в минуту на IP на процесс.

| Метод   | Путь                                                                | Данные                                                          |
| ------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| GET     | `/api/accounts`, `/api/styles`, `/api/queue`                        | Списки                                                          |
| POST    | `/api/accounts`                                                     | username, name, provider, externalId, styleId                   |
| POST    | `/api/accounts/:id/status`                                          | ACTIVE или PAUSED                                               |
| POST    | `/api/sources`                                                      | input, rights                                                   |
| POST    | `/api/prepare`                                                      | mode, adaptation?, mappings? либо sourceId + accountIds, force? |
| POST    | `/api/generate`                                                     | sourceId, accountId; кэш используется по умолчанию              |
| POST    | `/api/batches`                                                      | generatedIds, requestId, mode, adaptation?, approval?           |
| GET/PUT | `/api/accounts/:id/cta`                                             | PUT: text, url; правка личного CTA                              |
| PATCH   | `/api/sources/:id/features`                                         | topic?, format?, hook?                                          |
| GET     | `/api/performance?hours=24`                                         | hours=1/6/24/72/168, accountId?                                 |
| GET     | `/api/retention?days=0`                                             | период вступления когорт; 0 = вся история, accountId?           |
| POST    | `/api/drafts/:id/edit`, `/approve`                                  | text для редакции; допуск проверенной версии                    |
| POST    | `/api/jobs/:id/cancel`, `/reschedule`                               | scheduledAt для переноса                                        |
| POST    | `/api/factory`                                                      | paused                                                          |
| POST    | `/api/invites`                                                      | accountId; повтор использует постоянное приглашение             |
| POST    | `/api/tracking`                                                     | accountId, destination, ctaId?; постоянный код, без postId      |
| GET     | `/api/analytics`, `/api/analytics.csv`                              | days, accountId?, mode?                                         |
| GET     | `/api/analytics/top`, `/bottom`, `/dynamics`, `/sources`, `/styles` | Фильтры аналитики                                               |
| GET     | `/health`                                                           | Ресурсы и состояние зависимостей                                |
| POST    | `/api/demo/telegram`                                                | text либо callback; только офлайн-демо                          |

`requestId` обязателен для создания партии: повтор запроса вернёт ту же партию. Отменённые задачи не восстанавливаются. Ревизия задачи защищает от старых записей в Redis после переноса времени. PostgreSQL является источником истины; reconciler заново создаёт отсутствующие задачи Redis из состояния QUEUED.

Пример:

```bash
curl -H 'Authorization: Bearer demo-local-token' http://127.0.0.1:3000/api/analytics
```

В production не передавайте настоящий секрет в общие логи или скриншоты команд. Используйте локальный клиент и переменные окружения.

ACCOUNT_SPECIFIC — режим по умолчанию. В /api/prepare mappings содержит явные пары accountId/sourceId. В BROADCAST задайте sourceId, accountIds и COMMON либо PER_ACCOUNT. force=true — явная ручная перегенерация с новым LLM-запросом. Подготовка не создаёт очередь: её отдельно подтверждают через /api/batches.

Постовые клики и вступления в ответах аналитики — NULL. Account context рейтинга не доказывает источник отдельного поста. Retention показывает зрелые, проверенные и неизвестные когорты; процент отсутствует при неполном подтверждении. Подробнее — UPDATE_V1_1.md.

## Дополнения перед запуском

- GET/POST `/api/templates`; PATCH `/api/templates/:id`; POST `/api/templates/:id/examples` с text.
- PUT `/api/accounts/:id/template` с templateId или null.
- GET `/api/templates/:id/stats?hours=24`: rankEligible только от 10 сопоставимых замеров текущей версии.
- POST `/api/generations/:id/feedback` с rating GOOD/BAD; GET `/api/quality?accountId=...`.
- PUT `/api/accounts/:id/cta/enabled` с enabled boolean.
- POST `/api/diagnostics/browser` с scenario и profileId: изолированный DRY_RUN без реальных профилей.

В queued-задаче CTA не зафиксирован. ctaCapturedAt, ctaEnabled и версия заполняются при первом старте и сохраняются при повторных попытках. Слот равен 7200/N секунд, для десяти аккаунтов — 720 секунд. BROWSER_EXECUTION_MODE=DRY_RUN выключает реального исполнителя и Browser Local API.
