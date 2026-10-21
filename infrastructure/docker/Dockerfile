FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
RUN npm run db:generate && npx tsc
FROM build AS web
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run assets && npm run build -w @nexus/web
USER node
EXPOSE 3000
CMD ["npm","run","start","-w","@nexus/web"]
FROM nginx:1.28-alpine AS proxy
COPY infrastructure/nginx/nginx.conf /etc/nginx/conf.d/default.conf
FROM node:24-bookworm-slim AS backend
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/database ./packages/database
COPY --from=build /app/package*.json ./
COPY infrastructure/scripts/backup.py infrastructure/scripts/backup.py
RUN mkdir /app/data /app/secrets && chown node:node /app/data /app/secrets
ENV DATABASE_URL=file:/app/data/nexusssh.db SECRETS_FILE=/app/secrets/secrets.json
USER node
EXPOSE 3001
CMD ["sh","-c","touch /app/data/nexusssh.db && npx prisma migrate deploy --schema packages/database/prisma/schema.prisma && node dist/apps/api/src/main.js"]
