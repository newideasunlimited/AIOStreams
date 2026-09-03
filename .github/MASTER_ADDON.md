# Master Add-On

This fork is the private homelab-oriented Master Add-On build based on AIOStreams.

## Goal

Expose a single Stremio addon installation that aggregates all configured compatible Stremio addon sources through AIOStreams, while keeping provider-specific logic modular and replaceable.

## Project principles

- Preserve upstream AIOStreams compatibility wherever practical.
- Keep deployment secrets and service credentials out of Git.
- Treat upstream addons as replaceable provider adapters rather than hard-coding one source path.
- Query providers independently so one failed or slow provider does not block healthy sources.
- Deduplicate and normalize results through the existing AIOStreams pipeline.
- Keep playback normalization separate from aggregation. Use MediaFlow Proxy for remux/transcode where needed rather than embedding FFmpeg directly into the AIOStreams process.
- Prefer direct play first, remux second, transcode only when required.
- Target a self-hosted homelab deployment and a single Stremio manifest/install experience.

## Planned work

### Phase 1: Master source profile
- Curated source-category presets.
- Custom addon URL support using existing dynamic manifest discovery.
- Unified general, anime, live, adult-compatible, and other configured catalog groups.
- Provider timeout/failure isolation.
- Source health visibility.

### Phase 2: Playback compatibility
- First-class MediaFlow Proxy configuration.
- Direct-play compatibility checks.
- Remux path for container-only incompatibility.
- Transcode path for incompatible codecs.
- Homelab-oriented NVIDIA NVENC deployment guidance where supported by the host GPU/driver stack.

### Phase 3: Homelab UX
- Simplified single-user configuration profile.
- Backup/exportable configuration.
- Source enable/disable and priority controls.
- Clear health and failure reporting.

## Security

Never commit Real-Debrid, proxy, indexer, or other service credentials. All secrets belong in runtime environment/configuration storage excluded from Git.
