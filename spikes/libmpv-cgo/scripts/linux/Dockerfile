# Headless Linux test bed for the spike: GTK4/WebKitGTK 6 (Wails v3 default),
# libmpv, Xvfb + openbox + picom (X11 with a WM and a compositor), a de_DE
# locale (to reproduce mpv_create's LC_NUMERIC check) and mingw-w64 (to
# cross-compile the Windows build with cgo).
FROM debian:trixie
ARG GO_VERSION=1.25.0
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config \
      libgtk-4-dev libwebkitgtk-6.0-dev libx11-dev libmpv-dev \
      xvfb xdotool x11-utils x11-apps imagemagick picom \
      openbox dbus-x11 fonts-dejavu-core mesa-utils locales \
      gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 7zip \
    && sed -i 's/^# *\(de_DE.UTF-8\)/\1/' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*
RUN arch=$(dpkg --print-architecture) && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:$PATH GOFLAGS=-buildvcs=false
WORKDIR /spike
