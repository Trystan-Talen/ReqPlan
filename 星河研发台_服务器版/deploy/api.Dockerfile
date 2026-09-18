FROM node:24.19.0-bookworm-slim
WORKDIR /app
COPY --chown=node:node backend ./backend
COPY --chown=node:node frontend/workflow.js ./frontend/workflow.js
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node deploy/admin-recovery.mjs ./deploy/admin-recovery.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATABASE_PATH=/app/data/xinghe.sqlite
EXPOSE 3001
CMD ["node", "backend/server.mjs"]
