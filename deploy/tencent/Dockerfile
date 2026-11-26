FROM node:24-alpine
WORKDIR /opt/peerdesk
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node server.mjs ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0
ENV PEERDESK_DB=/data/accounts.sqlite
EXPOSE 8787
CMD ["node", "server.mjs"]
