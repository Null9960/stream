'use strict';
// ============================================================
// scraper.js — API fetch, HLS quality parsing, cache, dedup
// ============================================================
const axios = require('axios');

// ── Config ───────────────────────────────────────────────────
const API_URL   = process.env.VAPLAYER_API_URL || 'https://streamdata.vaplayer.ru/api.php';
const REFERER_BASE = 'https://brightpathsignals.com';
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS) || 10 * 60 * 1000; // 10 min
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE)    || 8;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Cache / dedup ────────────────────────────────────────────
const cache        = new Map();
const pending      = new Map();
let   activeScrapes = 0;

function cacheKey(imdbId, type, season, episode) {
    return `${imdbId}:${type}:${season || ''}:${episode || ''}`;
}

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
    return entry.streams;
}

function setCached(key, streams) {
    cache.set(key, { streams, ts: Date.now() });
    console.log(`[cache] set ${key} (size=${cache.size})`);
}

function invalidateCache(imdbId, type, season, episode) {
    const key = cacheKey(imdbId, type, season, episode);
    const had = cache.delete(key);
    if (had) console.log(`[cache] invalidated ${key}`);
    return had;
}

// ── Referer builder ──────────────────────────────────────────
function buildReferer(imdbId, type, season, episode) {
    if (type === 'series' && season && episode)
        return `${REFERER_BASE}/embed/tv/${imdbId}/${season}/${episode}`;
    return `${REFERER_BASE}/embed/movie/${imdbId}`;
}

// ── HLS quality parser ───────────────────────────────────────
// Parses RESOLUTION= and BANDWIDTH= from an EXT-X-STREAM-INF line.
function resolutionLabel(resolution, bandwidth) {
    if (resolution) {
        const h = parseInt(resolution.split('x')[1]) || 0;
        if (h >= 2160) return '4K';
        if (h >= 1440) return '2K';
        if (h >= 1080) return '1080p';
        if (h >= 720)  return '720p';
        if (h >= 480)  return '480p';
        if (h >= 360)  return '360p';
    }
    // Fallback from bandwidth (bps)
    if (bandwidth > 8_000_000) return '4K';
    if (bandwidth > 4_000_000) return '1080p';
    if (bandwidth > 2_000_000) return '720p';
    if (bandwidth > 800_000)   return '480p';
    return 'Auto';
}

function parseMasterPlaylist(body, masterUrl) {
    const base  = masterUrl.slice(0, masterUrl.lastIndexOf('/') + 1);
    const lines = body.split('\n');
    const seen  = new Set();
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

        const bwMatch  = line.match(/BANDWIDTH=(\d+)/);
        const resMatch = line.match(/RESOLUTION=([\dx]+)/);
        const bandwidth  = bwMatch  ? parseInt(bwMatch[1])  : 0;
        const resolution = resMatch ? resMatch[1] : null;

        const urlLine = lines[i + 1]?.trim();
        if (!urlLine || urlLine.startsWith('#')) continue;

        const url     = urlLine.startsWith('http') ? urlLine : base + urlLine;
        const quality = resolutionLabel(resolution, bandwidth);

        if (!seen.has(quality)) {
            seen.add(quality);
            variants.push({ url, quality, bandwidth });
        }
    }

    return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

// ── CDN probe ────────────────────────────────────────────────
// Returns { url, verified, body } where verified=true means a valid HLS playlist was read.
async function probeStream(m3u8Url, referer) {
    for (const headers of [
        { 'User-Agent': UA, Referer: referer, Origin: REFERER_BASE },
        { 'User-Agent': UA },
    ]) {
        try {
            const res = await axios.get(m3u8Url, {
                headers,
                timeout: 8000,
                maxRedirects: 5,
                responseType: 'text',
                validateStatus: s => s < 500,
            });
            if (res.status === 200) {
                const body = typeof res.data === 'string' ? res.data : '';
                if (body.trimStart().startsWith('#EXTM3U'))
                    return { url: m3u8Url, verified: true, body };
            }
            return { url: m3u8Url, verified: false };
        } catch { /* try without Referer */ }
    }
    return null; // unreachable / timeout
}

// ── Core fetch ───────────────────────────────────────────────
async function doFetch(imdbId, type, season, episode) {
    const referer = buildReferer(imdbId, type, season, episode);
    const apiType = type === 'series' ? 'tv' : 'movie';

    const params = { imdb: imdbId, type: apiType };
    if (type === 'series' && season && episode) {
        params.season  = season;
        params.episode = episode;
    }

    let apiRes;
    try {
        apiRes = await axios.get(API_URL, {
            params,
            headers: {
                'User-Agent': UA,
                'Referer': referer,
                'Origin': REFERER_BASE,
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
            },
            timeout: 12000,
            maxRedirects: 5,
        });
    } catch (e) {
        console.error('[scraper] API error:', e.message);
        return null;
    }

    const data = apiRes.data;
    console.log(`[scraper] API ${apiRes.status} — ${JSON.stringify(data).slice(0, 200)}`);

    if (apiRes.status !== 200 || !data?.data?.stream_urls?.length) {
        console.log('[scraper] No stream_urls in API response');
        return null;
    }

    const streamUrls = data.data.stream_urls;

    // Probe all CDN sources in parallel, pick first valid one
    const results = await Promise.all(streamUrls.map(u => probeStream(u, referer)));
    const best = results.find(r => r?.verified) || results.find(r => r && r.verified === false);

    if (!best) {
        // All sources unreachable — return raw first URL as last resort
        console.log('[scraper] All CDN sources unreachable, returning raw URL');
        return [{ url: streamUrls[0], quality: 'Auto', proxyable: false, referer }];
    }

    if (!best.verified || !best.body) {
        // CDN reachable but blocked pre-fetch — return as-is
        console.log('[scraper] CDN accessible but HLS pre-fetch blocked');
        return [{ url: best.url, quality: 'Auto', proxyable: false, referer }];
    }

    // Parse master playlist for real quality variants
    const variants = parseMasterPlaylist(best.body, best.url);
    if (variants.length > 0) {
        console.log(`[scraper] ${variants.length} variant(s): ${variants.map(v => v.quality).join(', ')}`);
        return variants.map(v => ({ ...v, proxyable: true, referer }));
    }

    // Verified media playlist (no variants)
    console.log('[scraper] Single media playlist');
    return [{ url: best.url, quality: '1080p', proxyable: true, referer }];
}

// ── Public API ───────────────────────────────────────────────
async function fetchVideoSource(imdbId, type = 'movie', season = null, episode = null) {
    if (!imdbId || !imdbId.startsWith('tt'))
        throw new Error(`Invalid IMDb ID: ${imdbId}`);

    const key = cacheKey(imdbId, type, season, episode);

    const cached = getCached(key);
    if (cached) { console.log(`[cache] hit ${key}`); return cached; }

    if (pending.has(key)) {
        console.log(`[cache] dedup wait ${key}`);
        return pending.get(key);
    }

    if (activeScrapes >= MAX_QUEUE) {
        console.log(`[scraper] queue full (${activeScrapes}/${MAX_QUEUE}) — rejecting`);
        return null;
    }

    activeScrapes++;
    const promise = doFetch(imdbId, type, season, episode)
        .then(streams => {
            if (streams) setCached(key, streams);
            pending.delete(key);
            activeScrapes = Math.max(0, activeScrapes - 1);
            return streams;
        })
        .catch(err => {
            console.error('[scraper] Error:', err.message);
            pending.delete(key);
            activeScrapes = Math.max(0, activeScrapes - 1);
            return null;
        });

    pending.set(key, promise);
    return promise;
}

function getStatus() {
    const now = Date.now();
    const entries = [];
    for (const [key, entry] of cache.entries())
        entries.push({ key, ageSeconds: Math.floor((now - entry.ts) / 1000) });
    return {
        activeScrapes,
        maxQueue: MAX_QUEUE,
        cache: { size: cache.size, ttlSeconds: Math.floor(CACHE_TTL / 1000), entries },
    };
}

module.exports = { fetchVideoSource, getStatus, invalidateCache, cacheKey, buildReferer, REFERER_BASE };
