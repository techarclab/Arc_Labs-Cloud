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
 && npm prune --omit=dev \
 && mkdir -p packages/shared/node_modules apps/api/node_modules apps/ingestion-worker/node_modules
# npm hoists most dependencies to /app/node_modules but nests a package under the workspace
# (apps/api/node_modules/...) when it cannot hoist it. Those nested folders are copied below as well;
# the mkdir above makes the COPY work when a workspace has none.

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/ingestion-worker/package.json apps/ingestion-worker/
COPY --from=build /app/apps/ingestion-worker/node_modules apps/ingestion-worker/node_modules
COPY --from=build /app/apps/ingestion-worker/dist apps/ingestion-worker/dist
COPY infra/db/migrations infra/db/migrations
# Root package.json lets `npm run start -w @arc/api` (a common platform default) work too.
COPY package.json ./
COPY tools/check-runtime-deps.cjs tools/
# Fail the image build, not the first boot, if a runtime dependency is missing from the final image.
RUN node tools/check-runtime-deps.cjs packages/shared apps/api apps/ingestion-worker
USER node
ENV ARC_ROLE=api
CMD ["sh", "-c", "if [ \"$ARC_ROLE\" = worker ]; then exec node apps/ingestion-worker/dist/main.js; else exec node apps/api/dist/main.js; fi"]
