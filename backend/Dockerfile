FROM oven/bun:1.4.5-debian AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential ca-certificates libssl-dev meson ninja-build pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY backend/src/security/files.ts ./src/security/files.ts
COPY backend/scripts/worker.ts backend/scripts/worker-rtp-limits.hpp ./scripts/
RUN bun run prepare:worker
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY backend/licenses ./licenses
RUN bun run build /out/voice-server \
    && bun scripts/notices.ts /out/licenses

FROM build AS checks
COPY backend/tsconfig.json backend/drizzle.config.ts ./
COPY backend/tests ./tests
RUN bun install --frozen-lockfile --ignore-scripts \
    && bun run check \
    && bun audit \
    && bun test tests/unit tests/integration

FROM debian:trixie-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 libssl3t64 curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 voice-server \
    && useradd --uid 10001 --gid voice-server --no-create-home --shell /usr/sbin/nologin voice-server \
    && install -d -m 0700 -o voice-server -g voice-server /data
COPY --from=build /out/voice-server /usr/local/bin/voice-server
COPY --from=build /out/licenses /usr/share/doc/voice-server/licenses/
COPY LICENSE backend/THIRD_PARTY_NOTICES.md /usr/share/doc/voice-server/
ENV VOICE_DATA_DIR=/data
WORKDIR /data
VOLUME ["/data"]
USER 10001:10001
EXPOSE 8443/tcp 8444/udp 8444/tcp
HEALTHCHECK --interval=30s --timeout=6s --start-period=10s CMD curl -kfSs --max-time 1 "https://[::1]:${VOICE_SERVER_PORT:-8443}/ready" || curl -fSs --max-time 1 "http://[::1]:${VOICE_SERVER_PORT:-8443}/ready" || curl -kfSs --max-time 1 "https://127.0.0.1:${VOICE_SERVER_PORT:-8443}/ready" || curl -fSs --max-time 1 "http://127.0.0.1:${VOICE_SERVER_PORT:-8443}/ready"
ENTRYPOINT ["/usr/local/bin/voice-server"]
