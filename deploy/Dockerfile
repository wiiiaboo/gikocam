# gikocam: relay + phone page in one container. Build context = repo root.
# Debian (not Alpine): @roamhq/wrtc, used for the relay's BRB stream, ships glibc builds only.
FROM node:22-bookworm-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/server.js server/brb-stream.js ./
COPY index.html app.js app.css brb.js ./public/
COPY brb ./public/brb
COPY test ./public/test
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
