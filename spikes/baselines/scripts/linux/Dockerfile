# Local stand-in for the ubuntu-24.04 CI runner: Linux packaging and bench
# (Xvfb, no GPU), plus the Windows cross-build (mingw-w64, NSIS).
#   docker build -t staysh-spike-baselines scripts/linux
#   docker run --rm -v "$PWD":/spike staysh-spike-baselines scripts/linux/package.sh
FROM golang:1.25-trixie AS go
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config file desktop-file-utils python3 \
      libgtk-4-dev libwebkitgtk-6.0-dev libmpv-dev xvfb xauth dbus-x11 fonts-dejavu-core \
      gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 nsis p7zip-full zip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=go /usr/local/go /usr/local/go
ENV PATH=/root/go/bin:/usr/local/go/bin:$PATH GOFLAGS=-buildvcs=false
RUN go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28
WORKDIR /spike
