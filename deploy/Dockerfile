# syntax=docker/dockerfile:1.7
# Ek Bharat.AI platform images: one Dockerfile, two targets.
#   docker build -f deploy/Dockerfile --target api    -t ekbharat/api .
#   docker build -f deploy/Dockerfile --target worker -t ekbharat/worker .
# NOT BUILT OR TESTED: Docker is not installed in the environment where this was written.
# Node 24 runs the TypeScript sources directly (type stripping) - there is no build step.
# Pin the base image by digest in your registry mirror before production (FROM node:24-bookworm-slim@sha256:...).

FROM node:24-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=production npm_config_fund=false npm_config_audit=false
# every workspace (incl. apps/web, whose dev-only deps are omitted) is needed for `npm ci` to resolve the workspace graph
COPY package.json package-lock.json ./
COPY packages ./packages
COPY modules ./modules
COPY apps ./apps
RUN npm ci --omit=dev --workspaces --include-workspace-root --ignore-scripts \
 && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLATFORM_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=512" \
    DOCUMENT_STORE_DIR=/data/documents
COPY --from=deps --chown=root:root /app /app
COPY --chown=root:root tooling ./tooling
COPY --chown=root:root modules.config.json ai-adapters.config.json tsconfig.json ./
# application files are root-owned and read-only for the runtime user; only /data and /tmp are writable
RUN mkdir -p /data/documents && chown node:node /data/documents && chmod 0700 /data/documents
USER node
# run the container with: --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges
STOPSIGNAL SIGTERM

FROM runtime AS api
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/src/main.ts"]

FROM runtime AS worker
ENV WORKER_HEALTH_PORT=8081
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.WORKER_HEALTH_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/worker/src/main.ts"]
