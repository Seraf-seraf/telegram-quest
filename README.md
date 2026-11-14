# Telegram Quest

TypeScript-приложение на Node.js 24 с Telegram webhook и изолированным runtime для скомпилированных историй Ink.

## Реализовано

- `api/webhook.ts` — Vercel POST entrypoint для grammY webhook.
- `internal/adapters/telegram/` — создание Bot и обработка webhook с проверкой секрета.
- `internal/config/` — проверка `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET`.
- `internal/domain/model.ts` — типы предметной модели, Ink-состояния и вариантов выбора без внешних SDK.
- `internal/app/story.ts` — независимый от Telegram и Ink контракт `StoryRuntime`.
- `internal/adapters/ink/runtime.ts` — запуск скомпилированного Ink, получение текста/выборов/тегов и передача сериализованного состояния между вызовами.
- `internal/adapters/ink/fixtures/` — тестовая Ink-история и её скомпилированный JSON.
- `internal/adapters/turso/migrations/001_initial.sql` — утверждённая начальная миграция; она ещё не применялась.

Runtime принимает содержимое `.ink.json`, а не путь или исходник `.ink`. Каждый вызов создаёт новый `inkjs.Story`. `stateJson` — непрозрачное сериализованное состояние с fingerprint скомпилированной истории; передавать его нужно вместе с тем же содержимым `.ink.json`. Несовпадающее содержимое вернёт `INVALID_STATE`. Telegram-бот пока не использует этот runtime, а состояние и ходы пока не сохраняются в Turso.

Чтобы пересобрать тестовую фикстуру закреплённым `inkjs-compiler`:

```sh
npx inkjs-compiler -o internal/adapters/ink/fixtures/demo.ink.json internal/adapters/ink/fixtures/demo.ink
```

## Следующие модули

Подключение runtime к игровым сессиям и Telegram, хранение в `internal/adapters/turso/store.ts`, сборка зависимостей в `internal/bootstrap.ts` и запуск миграций через `cmd/migrate.ts` остаются отдельными задачами.

## Команды

- `npm ci` — установить зафиксированные зависимости.
- `npm run typecheck` — проверить TypeScript-типы.
- `npm test` — запустить тесты.

Переменные Turso перечислены в `.env.example`, но клиент БД пока не подключён.
