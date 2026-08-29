FROM debian:bookworm-slim

LABEL com.fable.local-computer-image="true" \
      org.opencontainers.image.title="Fable Local Computer" \
      org.opencontainers.image.version="0.1.0-v3"

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
        procps \
        socat \
        thunar \
        tini \
        x11-utils \
        xdotool \
        xfce4-panel \
        xfce4-session \
        xfce4-settings \
        xfce4-terminal \
        xfdesktop4 \
        xfwm4 \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && dbus-uuidgen --ensure \
    && useradd --create-home --shell /bin/bash --uid 1000 fable

COPY rootfs/usr/local/bin/ /usr/local/bin/

RUN chmod 0755 /usr/local/bin/fable-*

USER fable
ENV DISPLAY=:99 \
    HOME=/home/fable \
    LANG=C.UTF-8
WORKDIR /home/fable/Workspace

EXPOSE 9223
HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 CMD ["/usr/local/bin/fable-ready"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/fable-desktop"]
