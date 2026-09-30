FROM debian:bookworm-slim

ARG NODE_VERSION=22.23.3

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    TZ=America/New_York \
    DAILY_CHECK_TIME=08:22

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      ffmpeg \
      python3 \
      unzip \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22, Deno (yt-dlp JS runtime), and a current yt-dlp binary.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64; deno_target=x86_64-unknown-linux-gnu; ytdlp_bin=yt-dlp_linux ;; \
      arm64) node_arch=arm64; deno_target=aarch64-unknown-linux-gnu; ytdlp_bin=yt-dlp_linux_aarch64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1; \
    curl -fsSL "https://github.com/denoland/deno/releases/latest/download/deno-${deno_target}.zip" -o /tmp/deno.zip; \
    unzip -o /tmp/deno.zip -d /usr/local/bin; \
    chmod 755 /usr/local/bin/deno; \
    rm -f /tmp/deno.zip; \
    curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlp_bin}" -o /usr/local/bin/yt-dlp; \
    chmod 755 /usr/local/bin/yt-dlp; \
    node --version; \
    deno --version; \
    yt-dlp --version; \
    ffmpeg -version | head -n 1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib

RUN mkdir -p /data
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
