# Linkstash

Linkstash is a local-first read-later queue. Save URLs, organize them with tags,
fetch page metadata, mark links read/unread, and pick a random unread link. Data
is stored in a local SQLite database. It binds to `127.0.0.1` by default and has
no accounts or multi-user isolation.

## Requirements

- Node.js **22.14.0**. The version is pinned in `.nvmrc`, `.node-version`,
  `package.json`, and the Docker image.
- npm 10+ (included with the pinned Node release).

## Clean Linux setup

```bash
git clone <repository-url> linkstash
cd linkstash
nvm install
nvm use
cp .env.example .env
npm ci
```

The `.env` file is optional. It contains settings only, not credentials:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
LINKSTASH_DB_PATH=./data/links.db
```

Never commit `.env` or the SQLite files under `data/`.

## Build, test, and run

Build the local CSS asset and run syntax checks:

```bash
npm run build
```

Run the one test command:

```bash
npm test
```

Start the server:

```bash
npm start
```

Open <http://127.0.0.1:3000>. `npm start` does not download anything or submit
anything; the build is a separate explicit step. The Windows convenience
launcher is `start.bat`.

## Docker

Build the production image:

```bash
docker build -t linkstash:local .
```

Run it with the SQLite database persisted outside the container:

```bash
mkdir -p data
docker run --rm --name linkstash \
  -p 3000:3000 \
  -v "$(pwd)/data:/data" \
  linkstash:local
```

Open <http://127.0.0.1:3000>. The image runs as the non-root `node` user,
binds to `0.0.0.0` inside the container, and includes a `/healthz` healthcheck.

## Features and safety

- URL validation accepts only credential-free HTTP(S) URLs.
- Metadata fetching rejects private, loopback, link-local, multicast,
  documentation, and IPv4-mapped IPv6 targets.
- Metadata work is bounded to two workers, retried up to three times, persisted
  in SQLite, and resumed after restart.
- Queue responses are paginated to 100 links and the UI has **Load more links**.
- SQLite schema changes use `PRAGMA user_version` migrations and indexes.
- API responses use no-store caching and basic browser hardening headers.
- Shutdown handles `SIGINT` and `SIGTERM` and closes active jobs, HTTP, and SQLite.

## Repository checks

```bash
npm run build
npm test
```

`npm ci` uses the committed `package-lock.json`; no absolute paths from the
development machine are required. The Docker build uses the same lockfile.
