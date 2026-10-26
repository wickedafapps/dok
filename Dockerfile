FROM node:24-alpine

ARG OPENCODE_VERSION=1.19.4

WORKDIR /app

# Runtime tools, plus a compiler toolchain for node-pty during npm ci.
RUN apk add --no-cache \
      git docker-cli docker-cli-compose bash curl ca-certificates libstdc++ \
    && apk add --no-cache --virtual .build-deps python3 make g++ linux-headers

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && apk del .build-deps

# OpenCode powers the on-demand Admin/User coding sessions. Installing the
# single release binary here keeps the image much smaller than npm optional
# dependencies, which would pull every platform variant.
RUN mkdir -p /opt/opencode \
    && curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh \
    && HOME=/opt/opencode bash /tmp/opencode-install.sh --version "$OPENCODE_VERSION" --no-modify-path \
    && rm -f /tmp/opencode-install.sh \
    && ln -sf /opt/opencode/.opencode/bin/opencode /usr/local/bin/opencode \
    && chmod -R a+rX /opt/opencode \
    && HOME=/opt/opencode opencode --version

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV OPENCODE_BIN=/usr/local/bin/opencode

EXPOSE 8080

VOLUME ["/app/data", "/app/sources", "/app/uploads", "/app/apps", "/app/core"]

CMD ["node", "server/index.js"]
