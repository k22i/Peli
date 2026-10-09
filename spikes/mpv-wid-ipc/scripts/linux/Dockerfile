# Headless Linux test bed for the spike: GTK4/WebKitGTK 6 (Wails v3 default),
# mpv, Xvfb + picom (X11 with a compositor) and headless Weston (Wayland).
FROM debian:trixie
ARG GO_VERSION=1.25.0
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config \
      libgtk-4-dev libwebkitgtk-6.0-dev libx11-dev \
      mpv xvfb xdotool x11-utils x11-apps imagemagick picom \
      weston xwayland openbox dbus-x11 fonts-dejavu-core mesa-utils \
    && rm -rf /var/lib/apt/lists/*
RUN arch=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH GOFLAGS=-buildvcs=false
WORKDIR /spike
