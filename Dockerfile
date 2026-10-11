# Runs anywhere Docker runs (AWS App Runner, ECS, Fly, a VPS). No build step.
FROM node:22-alpine
WORKDIR /app
# MG_LIVE_BUDGET_MS: Alexa+ wants each tool answered within 500 ms. From us-east-1 FINRA answers in
# about 150 ms; a slower answer is not waited for (the reply says so) and is cached for the next ask.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790 MG_LIVE_BUDGET_MS=400
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
