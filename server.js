'use strict';
// ============================================================
// server.js — HTTP server + HLS proxy + /health
// ============================================================
const express = require('express');
const axios   = require('axios');
const http    = require('http');
const https   = require('https');
const { getRouter } = require('stremio-addon-sdk');
const { builder }   = require('./addon');
const { getStatus, fetchVideoSource, invalidateCache, cacheKey, buildReferer, REFERER_BASE } = require('./scraper');

const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const START_TIME  = Date.now();
const PORT        = process.env.PORT || 7000;
const SERVER_BASE = (
    process.env.RENDER_EXTERNAL_URL ||
    process.env.SERVER_URL          ||
    `http://localhost:${PORT}`
).replace(/\/$/, '');

const PROXY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Uncaught errors ──────────────────────────────────────────
process.on('uncaughtException',   err => console.error('[UNCAUGHT]',   err.message));
process.on('unhandledRejection',  r   => console.error('[UNHANDLED]',  String(r)));

// ── Express app ──────────────────────────────────────────────
const app = express();

// Stremio SDK routes (manifest, stream handler, etc.)
app.use(getRouter(builder.getInterface()));

// ── Landing page ─────────────────────────────────────────────
app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PlayIMDB — Stremio Addon</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#0f0f13;color:#e0e0e0;min-height:100vh;
         display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px}
    .card{background:#1a1a24;border:1px solid #2a2a3a;border-radius:16px;
          padding:40px;max-width:520px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.4)}
    h1{font-size:1.6rem;font-weight:700;color:#fff;margin-bottom:6px}
    .sub{font-size:.82rem;color:#666;margin-bottom:16px}
    p{color:#999;font-size:.95rem;line-height:1.5;margin-bottom:28px}
    .btn{display:flex;align-items:center;justify-content:center;gap:8px;
         padding:12px 22px;border-radius:10px;font-size:.95rem;font-weight:600;
         text-decoration:none;width:100%;margin-bottom:12px;transition:opacity .2s;color:#fff}
    .btn:hover{opacity:.85}
    .install{background:#7b3fe4}
    hr{border:none;border-top:1px solid #2a2a3a;margin:24px 0}
    .tip{background:#12121a;border:1px solid #2a2a3a;border-radius:10px;
         padding:12px 14px;font-size:.82rem;color:#888;line-height:1.5}
    .tip strong{color:#bbb}
    footer{margin-top:24px;font-size:.75rem;color:#444;text-align:center}
    footer a{color:#666;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <h1>PlayIMDB</h1>
    <div class="sub">v2.0.0 · Movies, Series &amp; Anime</div>
    <p>Stream directly inside Stremio — no browser needed.</p>
    <a class="btn install" id="install">&#9654; Install in Stremio</a>
    <hr>
    <div class="tip">
      <strong>Android tip:</strong> If playback fails, go to
      <strong>Stremio → Settings → Player</strong> and switch to <strong>VLC</strong>.
      ExoPlayer may fail with proxied HLS streams.
    </div>
  </div>
  <footer>
    <a href="/manifest.json">manifest.json</a> &nbsp;·&nbsp;
    <a href="/health">health</a> &nbsp;·&nbsp;
    <a href="https://github.com/Null9960/stream" target="_blank">GitHub</a>
  </footer>
  <script>
    document.getElementById('install').href =
      'stremio://' + window.location.host + '/manifest.json';
  </script>
</body>
</html>`);
});

// ── Health endpoint ──────────────────────────────────────────
app.get('/health', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status:        'ok',
        version:       '2.0.0',
        uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
        scraper:       getStatus(),
        memory: {
            heapUsedMB:  (mem.heapUsed  / 1024 / 1024).toFixed(1),
            heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
            rssMB:       (mem.rss       / 1024 / 1024).toFixed(1),
        },
    });
});

// ── Proxy helpers ─────────────────────────────────────────────
function decodeProxy(encoded) {
    try { return JSON.parse(Buffer.from(encoded, 'base64url').toString()); }
    catch { return null; }
}

function parseRefererMeta(referer) {
    if (!referer) return null;
    const tv = referer.match(/\/embed\/tv\/(tt\d+)\/(\d+)\/(\d+)/);
    if (tv) return { imdbId: tv[1], type: 'series', season: tv[2], episode: tv[3] };
    const mv = referer.match(/\/embed\/movie\/(tt\d+)/);
    if (mv) return { imdbId: mv[1], type: 'movie', season: null, episode: null };
    return null;
}

function fetchUpstream(url, referer, extra = {}) {
    return axios.get(url, {
        headers: {
            'User-Agent': PROXY_UA,
            ...(referer ? { Referer: referer, Origin: REFERER_BASE } : {}),
        },
        timeout: 12000,
        maxRedirects: 5,
        validateStatus: s => s < 500,
        httpAgent,
        httpsAgent,
        ...extra,
    });
}

// ── HLS manifest proxy (/hls/:encoded.m3u8) ──────────────────
// Fetches the upstream .m3u8 with correct headers, then rewrites all
// relative URIs so they come back through this proxy — ensuring every
// segment request also carries the required Referer/Origin.
app.all('/hls/:encoded.m3u8', async (req, res) => {
    // CORS preflight
    res.set('Access-Control-Allow-Origin',  '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Range, Content-Type');
    if (req.method === 'HEAD' || req.method === 'OPTIONS') {
        res.set('Content-Type', 'application/x-mpegURL');
        return res.status(200).end();
    }

    const data = decodeProxy(req.params.encoded);
    if (!data?.u) return res.status(400).send('Bad request');

    let manifestUrl = data.u;
    let upstream    = null;

    try {
        upstream = await fetchUpstream(manifestUrl, data.r, { responseType: 'text' });
    } catch (err) {
        console.error('[proxy/hls] upstream error:', err.message);
        // Try one refresh via scraper
        const meta = parseRefererMeta(data.r);
        if (meta) {
            invalidateCache(meta.imdbId, meta.type, meta.season, meta.episode);
            try {
                const fresh = await fetchVideoSource(meta.imdbId, meta.type, meta.season, meta.episode);
                const newUrl = fresh?.[0]?.url;
                if (newUrl && newUrl !== manifestUrl) {
                    manifestUrl = newUrl;
                    upstream = await fetchUpstream(manifestUrl, data.r, { responseType: 'text' }).catch(() => null);
                }
            } catch { /* ignore */ }
        }
        if (!upstream) return res.status(502).send('Proxy error');
    }

    if (upstream.status !== 200) return res.status(upstream.status).send('CDN error');

    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    const ref  = data.r || '';
    const body = upstream.data.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        const abs = t.startsWith('http') ? t : base + t;
        const enc = Buffer.from(JSON.stringify({ u: abs, r: ref, b: base })).toString('base64url');
        return abs.includes('.m3u8')
            ? `${SERVER_BASE}/hls/${enc}.m3u8`
            : `${SERVER_BASE}/seg/${enc}.ts`;
    }).join('\n');

    res.set('Content-Type', 'application/x-mpegURL');
    res.set('Cache-Control', 'no-cache');
    res.send(body);
});

// ── HLS segment proxy (/seg/:encoded.ts) ─────────────────────
// Streams each TS segment from CDN with the required headers.
// On 403/5xx retries once after getting a fresh base URL from the scraper.
app.all('/seg/:encoded.ts', async (req, res) => {
    res.set('Access-Control-Allow-Origin',  '*');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.set('Accept-Ranges', 'bytes');
    if (req.method === 'HEAD' || req.method === 'OPTIONS') {
        res.set('Content-Type', 'video/MP2T');
        return res.status(200).end();
    }

    const data = decodeProxy(req.params.encoded);
    if (!data?.u) return res.status(400).send('Bad request');

    let segmentUrl = data.u;
    const referer  = data.r || '';
    const oldBase  = data.b || '';
    const MAX_RETRIES = 1;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const upstream = await axios.get(segmentUrl, {
                headers: {
                    'User-Agent': PROXY_UA,
                    ...(referer ? { Referer: referer, Origin: REFERER_BASE } : {}),
                    ...(req.headers.range ? { Range: req.headers.range } : {}),
                },
                timeout: 30000,
                responseType: 'stream',
                maxRedirects: 5,
                httpAgent,
                httpsAgent,
            });

            res.status(upstream.status);
            ['content-type','content-length','content-range','accept-ranges',
             'etag','last-modified','cache-control'].forEach(h => {
                if (upstream.headers[h]) res.set(h, upstream.headers[h]);
            });
            res.set('Access-Control-Allow-Origin', '*');

            let closed = false;
            req.on('close', () => { closed = true; upstream.data.destroy(); });
            upstream.data.on('error', err => {
                if (closed) return;
                console.error('[proxy/seg] stream error:', err.message);
                if (!res.headersSent) res.status(502).end();
                else res.end();
            });
            upstream.data.pipe(res);
            return;

        } catch (err) {
            const status = err.response?.status;
            const retryable = !status || status === 403 || status >= 502;
            console.error(`[proxy/seg] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${status || 'network'}): ${err.message}`);

            if (attempt < MAX_RETRIES && retryable && oldBase && segmentUrl.startsWith(oldBase)) {
                const meta = parseRefererMeta(referer);
                if (meta) {
                    try {
                        invalidateCache(meta.imdbId, meta.type, meta.season, meta.episode);
                        const fresh = await fetchVideoSource(meta.imdbId, meta.type, meta.season, meta.episode);
                        const newUrl = fresh?.[0]?.url;
                        if (newUrl) {
                            const newBase = newUrl.slice(0, newUrl.lastIndexOf('/') + 1);
                            if (newBase !== oldBase) {
                                segmentUrl = newBase + segmentUrl.slice(oldBase.length);
                                console.log('[proxy/seg] retry with fresh base');
                                continue;
                            }
                        }
                    } catch (e) {
                        console.error('[proxy/seg] refresh failed:', e.message);
                    }
                }
            }

            if (!res.headersSent) res.status(502).send('Proxy error');
            return;
        }
    }
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`PlayIMDB addon running on port ${PORT}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
    console.log(`Stremio:  stremio://localhost:${PORT}/manifest.json`);
});
