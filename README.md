# OrcaSlicer API

A RESTful service that leverages the OrcaSlicer CLI to slice 3D models (STL, STEP, 3MF).

This project only provides an REST API to the OrcaSlicer CLI, full credit to the [OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) contributors for the slicer itself.

## Features

- Slice models (STL, STEP, and 3MF) using OrcaSlicer and the profiles exported from it
- Export sliced models as a single G-code or 3MF (with G-code included) file, or as a ZIP file containing multiple G-code files
- Set parameters such as plate numbers, auto-arrange, auto-orient, filament, and more.
- Slice models asynchronously with a simple job system. (Experimental, see [Async Slicing](#async-slicing) for details)

## Requirements 

- **Node.js** v22
- **OrcaSlicer** (tested on Linux with AppImage and MacOS)

## Installation

### Production

> **WARNING:**
> This project is still in early development and may not be suitable for real production use yet. Use at your own risk and ensure you add proper security measures.

#### Docker

Prebuilt multi-arch images are published to GitHub Container Registry at `ghcr.io/afkfelix/orca-slicer-api`.

Pull and run the latest image for a supported OrcaSlicer version:

```bash
docker pull ghcr.io/afkfelix/orca-slicer-api:latest-orca2.3.0
mkdir ./data
docker run -d \
  --name orca-slicer-api \
  -p 3000:3000 \
  -v "./data:/app/data" \
  ghcr.io/afkfelix/orca-slicer-api:latest-orca2.3.0
```

Release images are also published with tags in the format `v<api-version>-orca<orca-version>`, for example:

```bash
docker pull ghcr.io/afkfelix/orca-slicer-api:v0.3.0-orca2.3.0
```

If you want to build the image locally instead use:

```bash
git clone https://github.com/AFKFelix/orca-slicer-api.git
cd orca-slicer-api
docker build --build-arg ORCA_VERSION=2.5.0 -t orca-slicer-api .
docker run -d -p 3000:3000 --name orca-slicer-api orca-slicer-api
```

#### Docker Compose

A `docker-compose.yml` is included for convenience. It defines two services:

| Service | Host port | Image source |
|---|---|---|
| `orca-slicer-api` | **3003** | Built locally from this repo's `Dockerfile` (default profile, carries the `bamdude/profile-resolver` patches — see below) |
| `bambu-studio-api` | **3001** | Built locally from `Dockerfile.bambu-studio` (gated behind `bambu` profile) |

Ports 3000 and 3002 are reserved by BamDude's virtual-printer feature, so
the OrcaSlicer sidecar sits on 3003. Override either host port via
`ORCA_API_PORT` / `BAMBU_API_PORT` in your `.env` if you don't run BamDude
on the same host.

```bash
# Start the OrcaSlicer sidecar only (default profile):
docker compose up -d
curl http://localhost:3003/health

# Build + start both. First build pulls a ~220MB BambuStudio AppImage
# and takes a few minutes; subsequent runs reuse the cached image.
docker compose --profile bambu up -d --build
curl http://localhost:3001/health
```

`Dockerfile.bambu-studio` reuses the same Node wrapper as the OrcaSlicer
image — BambuStudio's CLI accepts the same `--load-settings` / `--slice`
flags, so only the bundled AppImage and a few env vars differ. Pin the
BambuStudio version with `BAMBU_VERSION=02.09.01.70 docker compose ...`
(Ubuntu 22.04 AppImage variant — Fedora was dropped upstream after v02.06.x).

OrcaSlicer 2.5.0 ships its presets as binary `.opc` caches. The Orca image
also fetches the BBL JSON profiles from the same `v${ORCA_VERSION}` source
tag for the API's inheritance resolver, keeping the CLI's caches intact.
Both production and test images use this separate profile directory.

Beside the BBL tree the Orca image carries OrcaSlicer's filament library
(`OrcaFilamentLibrary`, the `... @System` presets of Elegoo, Polymaker, eSUN
and others). `GET /profiles/bundled` lists a library filament for every BBL
printer that has no preset of its own for that filament — the rule OrcaSlicer
itself applies — with `"library": true` and the printers it is offered for in
`compatible_printers`; a slice resolves it against the library's own bases.
BambuStudio has no such library, so its image lists the BBL tree alone.
The filament listing is ordered: real filaments before support materials,
and within each Bambu Lab, Generic, other brands of the BBL tree, then the
library.

> **Slicing Bambu-authored 3MFs?** OrcaSlicer 2.4.2 had CLI bugs
> that blocked slicing many Bambu-authored 3MFs — see
> upstream [OrcaSlicer#12426](https://github.com/SoftFever/OrcaSlicer/issues/12426)
> (segfault on painted multi-extruder files) and
> [OrcaSlicer#13386](https://github.com/SoftFever/OrcaSlicer/issues/13386)
> (parameter-range strict-validation reject). The 2.5.0 image passes our
> STL/3MF and profile-resolution checks, but the two Bambu-specific H2D
> bundle slicing cases remain excluded from the Orca test run; those cases
> are not certified by this update. Bambu Studio is recommended — the `bambu-studio-api` service
> above is a drop-in replacement with the same API surface.

### Local (Development)

```bash
git clone https://github.com/AFKFelix/orca-slicer-api.git
cd orca-slicer-api

# Create a .env file in the project root:
# .env example
ORCASLICER_PATH=/your/path/OrcaSlicer
DATA_PATH=/your/path/data
NODE_ENV=development
PORT=3000

# Install dependencies and start the dev server
npm install
npm run dev
```

## Configuration

`ORCASLICER_PATH` (required): Absolute path to the OrcaSlicer binary.\
`DATA_PATH` (required): Base directory for user uploaded profiles.\
`NODE_ENV` (required): Sets if run in development or production.\
`PORT` (optional): Port to run the server on, defaults to 3000.\
`ASYNC_SLICE_RETENTION_MS` (optional): Time in milliseconds to retain asynchronous slice jobs, defaults to 3600000 (60 minutes). Cleanup runs every 60 minutes.\
`BUNDLED_PROFILES_PATH` (optional): Absolute path to the bundled OrcaSlicer profiles directory (e.g. `<orca>/resources/profiles/BBL`). When unset the path is derived from `ORCASLICER_PATH` (`<dirname(ORCASLICER_PATH)>/resources/profiles/BBL`). Required for profile inheritance resolution — see below.\
`FILAMENT_LIBRARY_PATH` (optional): Absolute path to OrcaSlicer's filament library (`<orca>/resources/profiles/OrcaFilamentLibrary`). When unset it is the `OrcaFilamentLibrary` folder beside `BUNDLED_PROFILES_PATH`; a folder that does not exist simply means no library. Set it to an empty value to switch the library off.

Profiles are stored under:

```
<DATA_PATH>/
├── printers/
├── presets/
└── filaments/
```

Each profile is a JSON file from OrcaSlicer.

## Profile inheritance resolution

OrcaSlicer / BambuStudio user exports inherit from user-facing preset names like `"Bambu Lab X1 Carbon 0.4 nozzle"`, and they carry a handful of GUI-only quirks that trip up the CLI:

| Quirk | Why it breaks the CLI |
|---|---|
| `inherits: "<user-facing preset>"` | `--load-settings` does NOT run the GUI's preset-registry resolver, so even valid `fdm_*` parents are not pulled in. Required fields like `layer_change_gcode` end up missing. |
| `from: "User"` | The CLI's compatibility check rejects `from: "User"` profiles as incompatible with `from: "system"` filament/process pairs, regardless of name match. |
| `name: "# Bambu Lab X1 Carbon 0.4 nozzle"` | OrcaSlicer prefixes user clones of system presets with `# `. Bundled `compatible_printers` lists hold the un-prefixed names, so the literal compat match fails. |
| `prime_tower_brim_width: "-1"` (or empty strings) | The GUI accepts `-1` / `""` as "auto"; the CLI's range check rejects them with `"... not in range [...]"`. |

This service includes a profile resolver that addresses all four:

1. Walks the full `inherits:` chain against `resources/profiles/BBL/{machine,process,filament}/`, merging child-over-parent, and emits a fully-flattened profile with no `inherits:` field. A parent is found by the `name` its file states, anywhere under the category folder — brands keep presets in subfolders (`filament/P1P/`, `filament/SUNLU/`), and a name holding a `/` is stored under a file name that has `-` instead — never by composing `<name>.json`. A name two files claim is an error that names both. A parent that is not in the bundle refuses the request: `422 {"error": "preset_unresolved", "category", "preset", "missing_parent", "message", "details"}`, from `/slice` and `/profiles/resolve` alike. The CLI would ignore the unresolvable name and slice on its built-in defaults, reporting success — so a profile that is complete in itself must not carry an `inherits:`.
2. Rewrites `from: "User"` → `from: "system"` on the resolved output, since after flattening the profile *is* a system preset's content. One exception: a **printer** preset saved under a name of its own keeps `from: "User"` and gets `inherits:` set to the stock preset it was copied from (its nearest instantiable ancestor). The CLI checks a process's and a filament's `compatible_printers` against the printer's *system name* — its own name for a system preset, its `inherits` for a user one — so a renamed printer marked `system` was refused with every process. A process or filament whose list names the renamed printer itself has that stock parent added.
3. Strips the `# ` clone prefix from `name`, normalizing it to the system name in `compatible_printers`.
4. Strips `"-1"` and `""` sentinel values (and arrays where every element is one of those), letting the merged ancestor or the CLI's compiled-in default fill in.

The resolver runs automatically on every uploaded or stored profile that has an `inherits:` field. To use this in a custom deployment, ensure either `BUNDLED_PROFILES_PATH` is set or `ORCASLICER_PATH` points at an OrcaSlicer install whose `resources/profiles/BBL/` directory is present alongside it. The published Docker image satisfies this automatically.

## Wrapper version

`GET /health` reports `sidecarVersion` beside the slicer's own version
(`checks.orcaslicer.version`). It is the version of this wrapper's code — a
whole number in `src/version.ts`, raised by hand whenever something a caller
can depend on is added or changed, with a line there saying what. A caller
that needs a behaviour compares it with the number it needs; an image that
reports none predates it and counts as older.

## Security

**WARNING**: No authentication or authorization is implemented. This service should never be exposed directly to the public internet without adding proper security layers.

## Async Slicing

The API supports asynchronous slicing via the `/slice-async` endpoint to handle bigger models that take longer to slice, without running into HTTP timeouts.
When you submit a slicing job to this endpoint, it will return a unique `requestId` that you can use to check the status of the job and retrieve the results once it's completed. All jobs will run in the background in parallel, so there is no real queue system.

Please also note that the jobs are only stored in memory and should be deleted after retrieval. If not deleted, they will be automatically removed after the time specified in `ASYNC_SLICE_RETENTION_MS` (default is 60 minutes).

This feature is still experimental and might change in future releases, feedback is welcome!

## Roadmap

There are still several improvements planned:

- ~~Multi-plate slicing support~~ (added for 3MF files, returns ZIP of G-codes)
- ~~Enhanced slicing options~~
- ~~Improved error handling~~
- Better profile management system
- Strengthened security measures
- Additional quality-of-life features
- Better documentation
- ~~Tests and CI/CD setup~~

Feedback is welcome!

## API Endpoints

You can check the Swagger file in the project root or go to /api-docs when running in development.
