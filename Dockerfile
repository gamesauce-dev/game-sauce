FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

WORKDIR /app

# better-sqlite3 needs a native build when no prebuilt binary matches the
# Node version. Node 22 has prebuilds, but a newer lockfile entry can still
# fall back to node-gyp — which needs Python + a C++ toolchain. The slim
# image doesn't include those, so install them here. Without this the build
# fails with "gyp ERR! find Python ... Could not find any Python installation".
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY public ./public
COPY src ./src
COPY scripts ./scripts

# Writable at runtime: database, secret key, ROM storage, cached media.
VOLUME ["/app/data", "/app/storage"]
RUN mkdir -p /app/data /app/storage && chown -R node:node /app

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
