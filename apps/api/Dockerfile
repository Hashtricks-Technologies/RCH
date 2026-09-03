# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @rch/api...

FROM deps AS build
COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
RUN pnpm --filter @rch/api build \
 && pnpm --filter @rch/api deploy --prod --legacy /out \
 && rm -rf /out/src \
 && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /rds-global-bundle.pem

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ENV NODE_ENV=production PORT=3000 PG_CA_BUNDLE=/etc/ssl/rds-global-bundle.pem
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /rds-global-bundle.pem /etc/ssl/rds-global-bundle.pem
EXPOSE 3000
USER nonroot
CMD ["dist/server.mjs"]
