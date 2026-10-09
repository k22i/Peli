# Headless Linux test bed for the spike: GTK4/WebKitGTK 6 (Wails v3 default),
# libmpv, EGL/Wayland client libraries, and two sessions: X11 (Xvfb +
# openbox + picom, as in #2/#3) and Wayland (sway's headless backend; input
# through virtual devices, see vinput/, and screenshots with grim).
FROM golang:1.25-trixie
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config \
      libgtk-4-dev libwebkitgtk-6.0-dev libx11-dev libmpv-dev \
      libepoxy-dev libegl-dev libwayland-dev \
      xvfb xdotool x11-utils imagemagick picom openbox dbus-x11 \
      sway grim \
      fonts-dejavu-core mesa-utils locales procps \
    && rm -rf /var/lib/apt/lists/*
ENV GOFLAGS=-buildvcs=false
WORKDIR /spike
