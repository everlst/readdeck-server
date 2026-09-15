FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="ReadDeck Server" \
      org.opencontainers.image.source="https://github.com/everlst/readdeck-server" \
      org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache libarchive-tools poppler-utils

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY public/ ./public/

RUN mkdir -p /app/data /app/library

EXPOSE 13000

CMD ["node", "server.js"]
