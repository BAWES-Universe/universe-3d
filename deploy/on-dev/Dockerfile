# Trusted on-dev recipe. Generated public build metadata is added after the build.
# Branch code runs only in credential-free build/smoke jobs.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY public ./public
COPY src ./src
COPY server/bot-navigation.mjs ./server/bot-navigation.mjs
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build
FROM ${BASE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=4190 UNIVERSE_MODE=public \
    UNIVERSE_BIND_ADDRESS=0.0.0.0 UNIVERSE_DB=/data/universe.sqlite \
    UNIVERSE_TLS_MODE=external UNIVERSE_COOKIE_SECURE=always \
    UNIVERSE_REGISTRATION_MODE=disabled
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
COPY server.mjs package.json ./
COPY deploy-build.json ./deploy-build.json
COPY scripts/operator-account.mjs scripts/promote-owner.mjs scripts/healthcheck.mjs ./scripts/
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node:node
EXPOSE 4190
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "server.mjs"]
