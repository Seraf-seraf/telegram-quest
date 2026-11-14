# Telegram Quest

TypeScript-приложение на Node.js 24 с Telegram webhook, runtime для Ink и сохраняемыми игровыми сессиями.

## Компоненты

- `api/webhook.ts` — Vercel POST entrypoint для grammY webhook.
- `internal/adapters/telegram/` — создание Bot и обработка webhook с проверкой HTTP-метода и webhook secret.
- `internal/bootstrap.ts` — ленивая инициализация приложения и Turso; один успешный bootstrap переиспользуется внутри экземпляра процесса.
- `internal/adapters/turso/` — SQL-хранилище сессий и миграции схемы до версии 2.
- `internal/app/sessions.ts` — операции создания, запуска, чтения, выбора, паузы, продолжения, остановки, перезапуска и отката сессии.
- `internal/app/story-source.ts` — порт для загрузки закреплённой версии квеста.
- `internal/adapters/ink/runtime.ts` — запуск скомпилированного Ink, получение текста, выборов и тегов, передача сериализованного состояния между вызовами.
- `internal/adapters/ink/fixtures/` — тестовая Ink-история и её скомпилированный JSON.
- `internal/domain/model.ts` — типы предметной модели без внешних SDK.

`SessionService` и Turso store сохраняют прогресс пользователей и групп, проверяют версии состояния и применяют выборы атомарно. `pauseSession` сохраняет остаток активного таймера, `resumeSession` восстанавливает дедлайн; запуск таймера и голосование ещё не входят в реализованный сценарий. Перезапуск требует явного подтверждения, а откат удаляет выбранный ход и последующую историю вместе с зависимыми голосами.

## Инициализация и миграции

Для валидного POST webhook после проверки secret вызывается `getReadyApp()`. Bootstrap проверяет `TURSO_DATABASE_URL` и `TURSO_AUTH_TOKEN`, создаёт подключение и автоматически применяет недостающие миграции до схемы версии 2. Отдельная обязательная команда миграции не нужна. Ошибка инициализации возвращает webhook-ответ `503`; SQL и секреты клиенту не передаются.

`StorySource` передаётся в bootstrap явно. Сейчас production-каталог квестов не подключён, а Telegram handlers игрового процесса, интерфейс голосования и запуск таймеров не реализованы. Поэтому webhook и локальные компоненты хранения не означают, что Telegram-игра готова к прохождению.

## Тестовая Ink-фикстура

Чтобы пересобрать тестовую фикстуру закреплённым `inkjs-compiler`:

```sh
npx inkjs-compiler -o internal/adapters/ink/fixtures/demo.ink.json internal/adapters/ink/fixtures/demo.ink
```

## Команды

- `npm ci` — установить зафиксированные зависимости.
- `npm run typecheck` — проверить TypeScript-типы.
- `npm test` — запустить тесты.
