# gikocam: relay + phone page in one container. Build context = repo root.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/server.js ./
COPY index.html app.js app.css ./public/
COPY test ./public/test
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
