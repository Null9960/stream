# PlayIMDB Stream Stremio Addon

This repository contains a Stremio addon that resolves IMDb-based movie and series IDs into playable streams using a third-party upstream API.

## What It Does

- Exposes a Stremio manifest over HTTP.
- Accepts IMDb-backed Stremio IDs such as `tt1345836` or `tt0944947:1:1`.
- Calls a third-party API at `https://streamdata.vaplayer.ru/api.php`.
- Returns direct stream URLs with custom `proxyHeaders` so Stremio can send the required `Referer` and `Origin`.
- Attempts to fetch subtitles from `https://api.subdl.com/auto`.

## Runtime Flow

1. `server.js` starts the addon HTTP server with `stremio-addon-sdk`.
2. `addon.js` defines the manifest and handlers.
3. `defineStreamHandler` parses the Stremio ID, maps it to `movie` or `tv`, then calls the upstream stream API.
4. The handler returns `streams[]` entries directly to Stremio.
5. `defineSubtitlesHandler` separately queries SubDL for subtitle URLs.

## Important Notes

- This addon does not scrape IMDb pages. It uses IMDb IDs as lookup keys only.
- Playback depends almost entirely on external services outside this repository.
- Subtitle fetching is currently unreliable. A live check on 2026-05-05 returned `HTTP 422` from the current SubDL endpoint shape.
- The runtime is intentionally kept to the active path only: `addon.js` and `server.js`.

## Run Locally

```bash
npm install
npm start
```

Default manifest URL:

```text
http://localhost:7000/manifest.json
```

## Docker

```bash
docker build -t playimdb-addon .
docker run -p 7000:7000 playimdb-addon
```

## Known Risks

- Hard dependency on third-party domains and custom request headers.
- No authentication, rate limiting, retries, or caching beyond SDK-level HTTP cache.
- No tests.
- Legal and platform risk if upstream sources change policy or availability.
