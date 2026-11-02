FROM golang:1.25-bookworm AS vpn-build
WORKDIR /src
COPY services/vpn-gateway/go.mod services/vpn-gateway/go.sum ./
RUN go mod download
COPY services/vpn-gateway/ ./
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -o /vpn-gateway .
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run db:generate && npx tsc && npm run assets && npm run build -w @nexus/web
FROM node:24-bookworm-slim AS app
ARG APP_REVISION=unknown
ENV APP_REVISION=$APP_REVISION
COPY --from=vpn-build /vpn-gateway /usr/local/bin/nexus-vpn-gateway
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/database ./packages/database
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/package*.json ./
COPY infrastructure/scripts/backup.py infrastructure/scripts/recovery_bundle.py infrastructure/scripts/recovery_probe.mjs infrastructure/scripts/managed-backup.mjs infrastructure/scripts/start.mjs infrastructure/scripts/
RUN mkdir /app/data /app/secrets && chown node:node /app/data /app/secrets
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=file:/app/data/nexusssh.db SECRETS_FILE=/app/secrets/secrets.json
USER node
EXPOSE 8080
CMD ["node","infrastructure/scripts/start.mjs"]
