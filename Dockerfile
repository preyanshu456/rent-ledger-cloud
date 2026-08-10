FROM node:22-alpine
RUN apk add --no-cache unzip
WORKDIR /app
COPY rent-ledger-source.zip /tmp/rent-ledger-source.zip
RUN unzip -q /tmp/rent-ledger-source.zip -d /app && npm ci --omit=dev && mkdir -p /data
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
