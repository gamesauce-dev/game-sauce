FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV GAMESAUCE_INSTALL=docker
ENV HOST=0.0.0.0
ENV PORT=8080

WORKDIR /app

# better-sqlite3 13+ ships ready-made binaries (installed with --ignore-scripts below, so nothing is compiled). The
# toolchain is kept only as a safety net for anyone who swaps in a library version that has to be built from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# The picture library (WebP) has to load in this image, for amd64 and arm64: a build that cannot make a WebP stops here, not at the first customer.
RUN node -e "import('sharp').then(async (m) => { const b = await m.default({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).webp().toBuffer(); if (b.length < 10) process.exit(2); console.log('sharp ok', m.default.versions.sharp); })"

COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY launcher ./launcher

# Writable at runtime: database, secret key, ROM storage, cached media.
VOLUME ["/app/data", "/app/storage"]
RUN mkdir -p /app/data /app/storage && chown -R node:node /app

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
