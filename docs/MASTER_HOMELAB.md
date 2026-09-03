# Master Add-On Homelab Build

This branch turns AIOStreams into the single Stremio-facing addon for the homelab deployment while keeping upstream AIOStreams behavior intact.

## Current deployment shape

- `master-aiostreams`: built from this repository.
- `master-mediaflow`: local MediaFlow Proxy for playback compatibility.
- Persistent AIOStreams data: `./data:/app/data`.
- Secrets: runtime `.env` only; never commit populated credentials.

## First-run sequence

1. Copy `.env.homelab.sample` to `.env` on the homelab host.
2. Set `BASE_URL` to the address Stremio will use to reach AIOStreams.
3. Generate and set `SECRET_KEY` with `openssl rand -hex 32`.
4. Set a strong `MEDIAFLOW_API_PASSWORD`.
5. Start with `docker compose -f compose.homelab.yaml up -d --build`.
6. Open the AIOStreams configure/dashboard UI.
7. Configure the local MediaFlow instance as the playback proxy using the container URL `http://mediaflow:8888` and the password from `.env`.
8. Configure debrid/service credentials through AIOStreams runtime configuration. Do not store them in Git.
9. Add the resulting single AIOStreams manifest to Stremio.

## GPU verification

The MediaFlow service requests an NVIDIA GPU and enables transcoding with GPU preference. On the host, confirm Docker can expose the NVIDIA device before relying on NVENC. If GPU access is unavailable, MediaFlow should remain usable with CPU fallback while the host GPU runtime is corrected.

## Development priorities

### 1. Prove one-addon aggregation
Use AIOStreams' existing custom-addon and marketplace support. Verify streams, catalogs, metadata and subtitles all flow through the single installed manifest.

### 2. Prove playback normalization
Test three cases:
- direct-play compatible source;
- container/remux-only incompatibility;
- codec transcode requiring GPU acceleration.

### 3. Create the Master profile
Build a single-user preset around existing AIOStreams capabilities rather than duplicating the aggregator. Keep provider URLs and credentials runtime-configurable.

### 4. Failure isolation
Use bounded per-addon timeouts and concurrent requests so one unavailable provider cannot hold the entire response open.

### 5. Upstream maintenance
Keep `main` suitable for syncing upstream. Make custom changes on `brad/master-addon` and merge deliberately after testing.
