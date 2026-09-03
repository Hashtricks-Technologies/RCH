# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY UI ./UI
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @rch/ui... \
 && pnpm --filter @rch/ui build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ENV API_UPSTREAM=http://rch-api:3000
# Populates $NGINX_LOCAL_RESOLVERS from /etc/resolv.conf before envsubst runs,
# so the nginx template's `resolver` directive works under Docker and Kubernetes
# without hardcoding a DNS server address.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/UI/dist /usr/share/nginx/html
EXPOSE 8080
