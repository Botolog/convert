# The one image every prebuild runs in. Only generic tools go here,
# anything where the version matters should be a toolchain instead.

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

RUN sed -i "s|^# http://snapshot|URIs: http://snapshot|; /deb.debian.org/d" /etc/apt/sources.list.d/debian.sources

RUN apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      bzip2 \
      ca-certificates \
      cmake \
      file \
      git \
      patch \
      python3 \
      unzip \
      xz-utils \
      zip \
 && rm -rf /var/lib/apt/lists/*
