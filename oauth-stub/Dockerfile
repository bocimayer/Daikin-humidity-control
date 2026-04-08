# Tiny public stub for stable Daikin OAuth redirect_uri on Cloud Run.
# Build from repo root: docker build -f oauth-stub/Dockerfile oauth-stub

FROM node:20-alpine

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY server.js ./

ENV PORT=8080
EXPOSE 8080

USER appuser

CMD ["node", "server.js"]
