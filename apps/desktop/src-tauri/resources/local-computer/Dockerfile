# Base manifests are registry-verified and pinned. Debian package indexes remain
# intentionally current until the release process adopts an apt snapshot policy.
FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS gui-guard-build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY gui/fable-gui-exec-guard.c /build/guard.c
RUN gcc -shared -fPIC -O2 -Wall -Wextra -Werror /build/guard.c -o /build/fable-gui-exec-guard.so

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS node-runtime
FROM node-runtime AS document-tools-build
WORKDIR /document-tools
COPY documents/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY documents/smoke.mjs ./
RUN npm test

FROM node-runtime AS viewer-build
WORKDIR /viewer-build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY viewer/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN curl --fail --location --silent --show-error \
      https://codeload.github.com/kasmtech/noVNC/tar.gz/475ecfa5356579ef222983c7ce4619a7576a3bce \
      --output /tmp/kasm-client-source.tar.gz \
    && echo '325084abe7af9174812f06933a9f154d044b485254eda9f49ce511552a262420  /tmp/kasm-client-source.tar.gz' | sha256sum --check --status \
    && mkdir upstream \
    && tar -xzf /tmp/kasm-client-source.tar.gz --strip-components=1 -C upstream
COPY viewer/ ./
RUN node build.mjs \
    && mkdir -p /viewer-output/core/decoders/qoi \
    && cp upstream/core/decoders/qoi/qoi_viewer_bg.wasm /viewer-output/core/decoders/qoi/ \
    && cp upstream/LICENSE.txt /viewer-output/LICENSE.txt \
    && cp node_modules/pako/LICENSE /viewer-output/pako-LICENSE.txt

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

ARG FABLE_BUILD_CONTEXT_SHA256

LABEL com.fable.local-computer-image="true" \
      com.fable.build-context-sha256="${FABLE_BUILD_CONTEXT_SHA256}" \
      org.opencontainers.image.title="Fable Local Computer" \
      org.opencontainers.image.version="0.1.0-v5"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        chromium-sandbox \
        curl \
        dbus-x11 \
        fonts-dejavu-core \
        fonts-liberation \
        imagemagick \
        git \
        jq \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer \
        procps \
        poppler-utils \
        python3 \
        python3-aiohttp \
        python3-docx \
        python3-openpyxl \
        python3-pandas \
        python3-pip \
        python3-reportlab \
        python3-venv \
        ripgrep \
        thunar \
        tini \
        unzip \
        util-linux \
        x11-utils \
        x11-xserver-utils \
        xauth \
        xdotool \
        xfce4-panel \
        xfce4-session \
        xfce4-settings \
        xfce4-terminal \
        xfdesktop4 \
        xfwm4 \
        zip \
    && curl --fail --location --silent --show-error \
        https://github.com/kasmtech/KasmVNC/releases/download/v1.5.0/kasmvncserver_bookworm_1.5.0_amd64.deb \
        --output /tmp/kasmvnc.deb \
    && echo '770fd3df51510beecc89666879d82faf411276e68c6e11df612f736b891b5f71  /tmp/kasmvnc.deb' | sha256sum --check --status \
    && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/* \
    && dbus-uuidgen --ensure \
    && groupadd --gid 1001 fable-workspace \
    && useradd --create-home --shell /bin/bash --uid 1000 fable \
    && useradd --create-home --shell /bin/bash --uid 1001 --gid 1001 agent \
    && usermod --append --groups fable-workspace fable

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=document-tools-build /document-tools/node_modules /opt/fable/document-tools/node_modules
COPY --from=viewer-build /viewer-output /usr/share/fable-viewer
COPY --from=viewer-build /tmp/kasm-client-source.tar.gz /usr/share/doc/fable-local-computer/kasm-client-source.tar.gz
COPY viewer/ /usr/share/doc/fable-local-computer/viewer-build/
COPY documents/verify-guest-documents.sh /usr/local/bin/fable-verify-document-tools
COPY --from=gui-guard-build /build/fable-gui-exec-guard.so /usr/local/lib/fable-gui-exec-guard.so
COPY gui/ /usr/share/doc/fable-local-computer/gui/
COPY rootfs/usr/local/bin/ /usr/local/bin/
COPY rootfs/etc/kasmvnc/kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml
COPY rootfs/etc/chromium/policies/managed/fable.json /etc/chromium/policies/managed/fable.json
COPY rootfs/etc/sudoers.d/fable-terminal /etc/sudoers.d/fable-terminal
COPY rootfs/etc/xdg/xfce4/terminal/terminalrc /etc/xdg/xfce4/terminal/terminalrc
COPY rootfs/etc/libreoffice/registry/fable-security.xcd /etc/libreoffice/registry/fable-security.xcd

RUN apt-get update && apt-get install -y --no-install-recommends sudo xterm python3-pyatspi \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /usr/sbin/nologin --uid 1002 apps \
    && usermod --append --groups fable-workspace apps \
    && chmod 0440 /etc/sudoers.d/fable-terminal \
    && visudo --check --file /etc/sudoers.d/fable-terminal

RUN chmod 0755 /usr/local/bin/fable-* \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && NODE_PATH=/opt/fable/document-tools/node_modules fable-verify-document-tools

# Root owns service state. Chromium uses UID 1000, approved commands UID 1001,
# and closed-execution GUI applications UID 1002.
USER root
ENV DISPLAY=:99 \
    HOME=/home/fable \
    NODE_PATH=/opt/fable/document-tools/node_modules \
    XAUTHORITY=/run/fable-desktop/Xauthority \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/fable-desktop/bus \
    LANG=C.UTF-8
WORKDIR /home/fable/Workspace

EXPOSE 9223
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 CMD ["/usr/local/bin/fable-ready"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/fable-desktop"]
