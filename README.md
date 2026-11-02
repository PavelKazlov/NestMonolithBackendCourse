# Backend Course — NestJS monolith

Учебный проект курса Innowise Back End (группа A1). Запросы для ручной проверки — в [`http/`](http/).

## Quick start

```bash
cp .env.example .env && cp .env.test.example .env.test
docker compose up -d          # Postgres :5433, Mailpit :1025 / UI :8025
npm ci
npm run start:dev             # API :3007, Swagger :3007/docs
```

## Template notes

NestJS backend project template. HTTP kernel is **Fastify** (`@nestjs/platform-fastify`), not Express — use Fastify plugins and types (`NestFastifyApplication`, `app.register(...)`) in `src/main.ts`. Compression (`@fastify/compress`) and cookies (`@fastify/cookie`) are already registered.

## Scripts

```bash
npm run start:dev    # Development with hot reload
npm run start:prod   # Production
npm run build        # Build
npm run lint         # Lint & fix
npm run test         # Unit tests
npm run test:e2e     # E2E tests (БД app_test, .env.test)
npm run test:cov:all # Coverage: unit + e2e
```

## Project Structure

```
src/
├── core/
│   ├── config/      # App configuration (env variables)
│   ├── crypto/      # HMAC, constant-time compare, OTP/token generation
│   ├── errors/      # AppException + global exception filter
│   ├── logger/      # pino structured logs, X-Request-Id
│   ├── mail/        # MailSender port + SMTP adapter
│   ├── database/    # TypeORM + PostgreSQL connection
│   ├── health/      # /health, /health/live, /health/ready
│   └── app/         # Root module + app.setup (shared by main.ts and e2e)
├── database/        # TypeORM CLI data-source and migrations
├── modules/         # Feature modules
└── main.ts          # Entry point
```

## Database

PostgreSQL and TypeORM are already wired in. Use them for new modules — no extra setup.

- **Local Postgres:** `docker compose up -d` (image and credentials from `.env` / `.env.example`)
- **Connection:** `DatabaseModule` (`src/core/database`) is imported in `AppModule`
- **Entities:** any `*.entity.ts` under `src/` is auto-loaded
- **Repositories:** `TypeOrmModule.forFeature([YourEntity])` in a feature module, then `@InjectRepository(YourEntity)`
- **Transactions:** `@Transactional()` from `typeorm-transactional` (context is initialized in `main.ts`)
- **Schema:** migrations in `src/database/migrations/`. `POSTGRES_SYNCHRONIZE` is `false` by default — do not rely on auto-sync

```bash
npm run migration:generate --name=CreateUsers   # Generate from entity changes
npm run migration:run        # Apply pending migrations
npm run migration:revert     # Roll back the last migration
npm run migration:show       # List applied / pending
```

CLI uses `src/database/data-source.ts`. At runtime, Nest uses the DataSource from `DatabaseModule`. If `POSTGRES_MIGRATIONS_RUN=true`, pending migrations also run on app start.

## Libraries

| Purpose       | Library                  |
|---------------|--------------------------|
| HTTP          | Fastify (`@nestjs/platform-fastify`) |
| Validation    | Joi                      |
| ORM           | TypeORM (`@nestjs/typeorm`) |
| Database      | PostgreSQL (`pg`)        |

## Core Modules

| Purpose       | Module           |
|---------------|-----------------|
| Configuration | `ConfigModule`  |
| Database      | `DatabaseModule` |
| Health Check  | `HealthModule`  |

## Adding a Module

```bash
nest generate module <name>
nest generate controller <name>
nest generate service <name>
```

## Code Style

- Use `@` aliases for imports (e.g., `@config/config.service`)
- Run `npm run format` before committing
- Follow NestJS module pattern
