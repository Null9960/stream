# Analysis Report

Date: 2026-05-05

## Architecture Summary

The addon is a thin adapter between Stremio and an external streaming data provider.

- `server.js` boots the Stremio HTTP interface.
- `addon.js` contains the actual runtime behavior.
- `Dockerfile` and `docker-compose.yml` package the addon for container use.

## How The Addon Works

### 1. Manifest exposure

`server.js` calls `serveHTTP(builder.getInterface(), { port, cache: 3600 })`, which makes the addon discoverable by Stremio through `/manifest.json`.

### 2. Stream resolution

`addon.js` parses the incoming Stremio ID:

- movie: `tt1345836`
- episode: `tt0944947:1:1`

It converts series requests into `type=tv` and calls:

`https://streamdata.vaplayer.ru/api.php`

with browser-like headers, including fixed `Referer` and `Origin`.

If the upstream response contains `stream_urls`, the addon returns them directly as Stremio stream entries and attaches `behaviorHints.proxyHeaders` so the player can reuse the expected headers.

### 3. Subtitle lookup

The subtitle handler queries:

`https://api.subdl.com/auto`

using the IMDb ID and optional season or episode values, then maps language codes into ISO 639-2 style values.

## Verified Findings

### Operational findings

1. The upstream stream API is currently live.
   A direct request for `tt1345836` on 2026-05-05 returned `status_code=200` and playable HLS-style URLs.

2. Subtitle lookup is currently broken or incompatible.
   A direct request to the current SubDL endpoint shape returned `HTTP 422` on 2026-05-05.

### Code weaknesses

1. Container build was broken.
   The original `Dockerfile` attempted to copy `lib/`, but that directory does not exist in this project.

2. Subtitle failures are hidden.
   Both subtitle implementations swallow upstream errors and return an empty result, which makes diagnosis harder.

3. Quality labels are heuristic only.
   `getQuality()` infers quality from filename or URL patterns rather than verified media metadata.

4. Fixed upstream fingerprints create fragility.
   Hardcoded `Referer`, `Origin`, CDN naming rules, and endpoint domains make the addon brittle if the upstream provider changes anti-bot or routing behavior.

5. No tests or health validation beyond manifest reachability.
   There are no automated tests for ID parsing, API failure handling, or subtitle behavior.

6. Legal and trust risk is externalized.
   The addon depends on third-party stream providers and proxies around origin restrictions, which may create service, policy, or copyright exposure.

## Suggested Priorities

1. Replace silent subtitle failures with structured logs and revalidate the current SubDL contract.
2. Add smoke tests for `parseId`, stream handler fallback behavior, and manifest exposure.
3. Move upstream domains and headers into environment variables.
4. Add a basic README and deployment notes so future maintenance is not guesswork.
