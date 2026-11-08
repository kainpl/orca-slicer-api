FROM node:22-bookworm AS build

ARG ORCA_VERSION=2.5.0
ARG TARGETARCH

WORKDIR /app

# OrcaSlicer publishes official Ubuntu 24.04 AppImages for both architectures.
RUN set -eu; \
    case "$TARGETARCH" in \
        amd64) ARCH_SUFFIX="" ;; \
        arm64) ARCH_SUFFIX="_aarch64" ;; \
        *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fL -o orca.AppImage "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404${ARCH_SUFFIX}_V${ORCA_VERSION}.AppImage"; \
    chmod +x orca.AppImage; \
    ./orca.AppImage --appimage-extract; \
    rm orca.AppImage

# Orca 2.5+ ships packed .opc caches instead of preset JSON. The wrapper's
# inheritance resolver needs the JSON from the SAME release, separately from
# the CLI's untouched cache. Sparse checkout avoids downloading other vendors.
RUN set -eu; \
    git clone --depth 1 --filter=blob:none --sparse --branch "v${ORCA_VERSION}" \
        https://github.com/OrcaSlicer/OrcaSlicer.git /tmp/orca-source; \
    git -C /tmp/orca-source sparse-checkout set resources/profiles/BBL; \
    mkdir -p /app/bundled-profiles; \
    cp /tmp/orca-source/resources/profiles/BBL.json /app/bundled-profiles/; \
    cp -r /tmp/orca-source/resources/profiles/BBL /app/bundled-profiles/; \
    test -s /app/bundled-profiles/BBL/machine/fdm_machine_common.json; \
    rm -rf /tmp/orca-source

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM ubuntu:24.04

RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends \
	curl ca-certificates gnupg \
	&& mkdir -p /etc/apt/keyrings \
	&& curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
	&& echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends \
	nodejs \
	libgl1 libgl1-mesa-dri libegl1 libopengl0 libglu1-mesa \
	libsm6 libice6 libmspack0 \
	libgtk-3-0 \
	libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
	libwebkit2gtk-4.1-0 \
	&& update-ca-certificates \
	&& rm -rf /var/lib/apt/lists/*


COPY --from=build /app/dist/src /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/squashfs-root /app/squashfs-root
COPY --from=build /app/bundled-profiles /app/bundled-profiles

ENV PORT=3000
ENV ORCASLICER_PATH=/app/squashfs-root/AppRun
ENV BUNDLED_PROFILES_PATH=/app/bundled-profiles/BBL
ENV DATA_PATH=/app/data
ENV NODE_ENV=production
# Which slicer this image wraps. The wrapper itself is slicer-agnostic;
# tests use this to skip coverage that only applies to one of them.
ENV SLICER_FLAVOR=orca

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "app/dist/index.js"]
