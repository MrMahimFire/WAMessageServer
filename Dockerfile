FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Persistent data (SQLite database) lives here. Mount a persistent disk/volume at /data.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATA_DIR=/data
ENV PORT=7860
VOLUME ["/data"]

USER node
EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "index.js"]
