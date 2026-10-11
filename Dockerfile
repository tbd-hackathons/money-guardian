# Runs anywhere Docker runs (AWS App Runner, ECS, Fly, a VPS). No build step.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY registers ./registers
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8790/healthz || exit 1
CMD ["node", "src/server.js"]
