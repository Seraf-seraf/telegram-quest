# Telegram Quest

Минимальная структура TypeScript-приложения на Node.js. Игровая логика, голосование и сессии пока не реализованы.

## Создано

- `api/webhook.ts` — Vercel POST entrypoint для grammY webhook.
- `internal/adapters/telegram/` — создание Bot и обработка webhook с проверкой секрета.
- `internal/config/` — проверка `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET`.
- `internal/domain/model.ts` — типы предметной модели без внешних SDK.
- `internal/adapters/turso/migrations/001_initial.sql` — утверждённая начальная миграция; она ещё не применялась.

## Будущие модули

`internal/app/` для прикладных сценариев, `internal/adapters/ink/` для runtime Ink, `internal/adapters/turso/store.ts` для хранения, `internal/bootstrap.ts` для сборки зависимостей и `cmd/migrate.ts` для запуска миграций будут добавлены вместе с соответствующими задачами.

## Команды

- `npm ci` — установить зафиксированные зависимости.
- `npm run typecheck` — проверить TypeScript-типы.
- `npm test` — запустить тесты.

Переменные Turso перечислены в `.env.example`, но клиент БД пока не подключён.
