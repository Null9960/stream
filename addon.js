'use strict';
// ============================================================
// addon.js — Stremio manifest + stream handler
// ============================================================
const { addonBuilder } = require('stremio-addon-sdk');
const { fetchVideoSource, buildReferer, invalidateCache } = require('./scraper');

const PORT        = process.env.PORT || 7000;
const SERVER_BASE = (
    process.env.RENDER_EXTERNAL_URL ||
    process.env.SERVER_URL          ||
    `http://localhost:${PORT}`
).replace(/\/$/, '');

// ── Manifest ─────────────────────────────────────────────────
const manifest = {
    id:          'community.playimdb.streamimdb',
    version:     '2.0.0',
    name:        'PlayIMDB',
    description: 'Watch movies, series, and anime via streamimdb — natively inside Stremio.',
    logo:        'https://raw.githubusercontent.com/Null9960/stream/main/icon.png',
    resources:   ['stream'],
    types:       ['movie', 'series'],
    idPrefixes:  ['tt'],
    catalogs:    [],
    behaviorHints: {
        configurable:          false,
        configurationRequired: false,
    },
};

const builder = new addonBuilder(manifest);

// ── HLS proxy URL builder ─────────────────────────────────────
function makeProxyUrl(streamUrl, referer) {
    const payload = Buffer.from(JSON.stringify({ u: streamUrl, r: referer })).toString('base64url');
    return `${SERVER_BASE}/hls/${payload}.m3u8`;
}

// ── Stream handler ────────────────────────────────────────────
builder.defineStreamHandler(async (args) => {
    try {
        const parts   = args.id.split(':');
        const imdbId  = parts[0];
        const type    = parts.length > 1 ? 'series' : args.type === 'series' ? 'series' : 'movie';
        const season  = parts[1] || null;
        const episode = parts[2] || null;

        console.log(`[handler] ${args.id}  type=${type}  S=${season}  E=${episode}`);

        let streams = await fetchVideoSource(imdbId, type, season, episode);

        // One retry on transient null
        if (!streams) {
            await new Promise(r => setTimeout(r, 800));
            streams = await fetchVideoSource(imdbId, type, season, episode);
        }

        if (!streams || streams.length === 0) {
            console.log(`[handler] No streams for ${args.id}`);
            return { streams: [] };
        }

        const referer = buildReferer(imdbId, type, season, episode);

        const result = streams.map(s => {
            const url = s.proxyable !== false
                ? makeProxyUrl(s.url, referer)
                : s.url;

            const streamObj = {
                url,
                name:  'PlayIMDB',
                title: buildTitle(s, type, season, episode),
            };

            if (s.proxyable === false) {
                streamObj.behaviorHints = {
                    notWebReady: true,
                    proxyHeaders: {
                        request: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                            'Referer':    referer,
                            'Origin':     'https://brightpathsignals.com',
                        },
                    },
                    bingeGroup: bingeGroupId(imdbId, type, season),
                };
            } else {
                // Proxied — fully web-ready, notWebReady OMITTED intentionally
                streamObj.behaviorHints = {
                    bingeGroup: bingeGroupId(imdbId, type, season),
                };
            }

            return streamObj;
        });

        console.log(`[handler] Returning ${result.length} stream(s) for ${args.id}`);
        return { streams: result };

    } catch (err) {
        console.error('[handler] Unexpected error:', err.message);
        return { streams: [] };
    }
});

// ── Helpers ───────────────────────────────────────────────────
function buildTitle(stream, type, season, episode) {
    const q = stream.quality || 'Auto';
    if (type === 'series' && season && episode)
        return `S${season}E${episode} · ${q}`;
    return q;
}

function bingeGroupId(imdbId, type, season) {
    if (type === 'series' && season)
        return `playimdb-${imdbId}-s${season}`;
    return `playimdb-${imdbId}`;
}

module.exports = { builder };
