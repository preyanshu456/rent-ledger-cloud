FROM node:22-alpine
WORKDIR /app

# The actual app (package.json, server.js, app.js, etc.) lives inside the
# rent-ledger-source/ folder in the repo, not at the repo root.

# Install dependencies first (better layer caching)
COPY rent-ledger-source/package*.json ./
RUN npm install --omit=dev

# Copy the rest of the app folder as-is — whatever is committed to GitHub
# under rent-ledger-source/ is exactly what ends up in the image, no zip
# step involved.
COPY rent-ledger-source/ .
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
