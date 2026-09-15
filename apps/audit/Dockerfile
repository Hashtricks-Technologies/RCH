# syntax=docker/dockerfile:1.7
# The audit service (apps/audit). The same shape as apps/api/Dockerfile, narrowed to what this
# service depends on: @rch/contract and nothing else - no @rch/domain, no apps/api.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/contract/package.json packages/contract/
COPY apps/audit/package.json apps/audit/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @rch/audit...

FROM deps AS build
COPY packages/contract ./packages/contract
COPY apps/audit ./apps/audit
COPY tsconfig.base.json ./
RUN pnpm --filter @rch/audit build \
 && pnpm --filter @rch/audit deploy --prod --legacy /out \
 && rm -rf /out/src \
 && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /rds-global-bundle.pem

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ENV NODE_ENV=production PORT=3100 PG_CA_BUNDLE=/etc/ssl/rds-global-bundle.pem
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/audit/dist ./dist
COPY --from=build /repo/apps/audit/drizzle ./drizzle
COPY --from=build /rds-global-bundle.pem /etc/ssl/rds-global-bundle.pem
EXPOSE 3100
USER nonroot
CMD ["dist/server.mjs"]
