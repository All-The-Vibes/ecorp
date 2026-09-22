FROM --platform=linux/amd64 node:24.19.0-bookworm-slim@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174 AS node
FROM --platform=linux/amd64 rust:1.98.1-bookworm@sha256:cdb2da72943ec036bf0c731ef5ac9e5fb2b1d17d3a9256a581bad64cf6fc093d

LABEL org.opencontainers.image.title="ECorp contributor environment" \
      org.opencontainers.image.description="Pinned Linux build tools; no product services or provider credentials"

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install --global --registry=https://registry.npmjs.org pnpm@11.19.0 \
    && npm cache clean --force \
    && rustup component add --toolchain 1.98.1 rustfmt clippy \
    && groupadd --gid 1000 developer \
    && useradd --uid 1000 --gid developer --create-home --shell /bin/bash developer \
    && mkdir -p /home/developer/.cargo /workspaces/ecorp \
    && chown developer:developer /home/developer/.cargo /workspaces/ecorp

ENV CARGO_HOME=/home/developer/.cargo \
    CARGO_BUILD_JOBS=2 \
    RUSTUP_AUTO_INSTALL=0 \
    COPILOT_SKIP_CLI_DOWNLOAD=1

USER developer
WORKDIR /workspaces/ecorp
