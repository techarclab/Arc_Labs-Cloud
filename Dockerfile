# One image for the API and the ingestion worker.
# docker-compose passes the command; on Railway set ARC_ROLE=worker for the worker service (default: api).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/ingestion-worker/package.json apps/ingestion-worker/
COPY apps/console/package.json apps/console/
COPY tools/device-simulator/package.json tools/device-simulator/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN npm run build -w @arc/shared && npm run build -w @arc/api -w @arc/ingestion-worker \
 && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/ingestion-worker/package.json apps/ingestion-worker/
COPY --from=build /app/apps/ingestion-worker/dist apps/ingestion-worker/dist
COPY infra/db/migrations infra/db/migrations
USER node
ENV ARC_ROLE=api
CMD ["sh", "-c", "if [ \"$ARC_ROLE\" = worker ]; then exec node apps/ingestion-worker/dist/main.js; else exec node apps/api/dist/main.js; fi"]
