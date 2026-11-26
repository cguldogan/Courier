# Container image of the Courier command-line runner (`courier run`, `courier mock`), for build
# agents that should not need Node.js installed:
#
#   docker run --rm -v "$PWD:/work" ghcr.io/cguldogan/courier run /work/collection.json
#
# Published to the GitHub Container Registry by .github/workflows/container.yml (linux/amd64 and
# linux/arm64). See README, "Container image".
#
# Build stage: runs on the build machine's own platform. The bundle is plain JavaScript and the
# runtime dependencies have no native modules (quickjs-emscripten is WebAssembly), so one build
# serves every target platform and the runtime stage needs no emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false
COPY package.json package-lock.json ./
# No install scripts: nothing the CLI build needs runs one (Electron's would download its binary).
RUN npm ci --ignore-scripts
COPY tsconfig.json cli.vite.config.mts ./
COPY src ./src
COPY docker/cli-deps.mjs ./docker/
# out/cli/courier.cjs plus exactly the locked packages it requires, in /opt/courier.
RUN npm run build:cli && node docker/cli-deps.mjs /opt/courier

# Runtime stage: Node.js 22 on Alpine, the bundle and its production dependencies, nothing else.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ARG VERSION=dev
LABEL org.opencontainers.image.title="Courier CLI" \
      org.opencontainers.image.description="Courier command-line runner: run Courier and Postman collections (console, JSON and JUnit reports) and serve saved examples with courier mock" \
      org.opencontainers.image.source="https://github.com/cguldogan/Courier" \
      org.opencontainers.image.url="https://github.com/cguldogan/Courier" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
COPY --from=build /opt/courier /opt/courier
ENV PATH=/opt/courier/bin:$PATH \
    NODE_ENV=production \
    NO_UPDATE_NOTIFIER=1
# The image's unprivileged `node` user (uid 1000). Mount the collection directory at /work; pass
# --user "$(id -u):$(id -g)" when reports are written into a host directory.
USER node
WORKDIR /work
ENTRYPOINT ["courier"]
CMD ["--help"]
