FROM node:22.14.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:css \
    && npm prune --omit=dev \
    && mkdir -p /data \
    && chown -R node:node /app /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LINKSTASH_DB_PATH=/data/links.db

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
