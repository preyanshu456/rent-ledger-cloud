FROM node:22-alpine
WORKDIR /app

# The actual app (package.json, server.js, app.js, etc.) lives inside the
# rent-ledger-source/ folder in the repo, not at the repo root.

# Install dependencies first (better layer caching)
COPY rent-ledger-source/package*.json ./
# npm ci installs exactly what package-lock.json lists (reproducible builds).
RUN npm ci --omit=dev

# Copy the rest of the app folder as-is — whatever is committed to GitHub
# under rent-ledger-source/ is exactly what ends up in the image, no zip
# step involved.
COPY rent-ledger-source/ .
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
# node:sqlite is built in (Node 22.13+); the flag only hides its "experimental" notice.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
