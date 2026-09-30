FROM node:22-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true CHROMIUM_PATH=/usr/bin/chromium CHROMIUM_NO_SANDBOX=true DATA_DIR=/app/data
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/alertas-entrypoint
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 9012
ENTRYPOINT ["/usr/local/bin/alertas-entrypoint"]
CMD ["node", "src/server.js"]
