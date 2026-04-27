FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY README.md ./
COPY docs ./docs
COPY examples ./examples
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.mjs"]
