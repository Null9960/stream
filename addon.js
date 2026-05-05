const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');

// =============================================
// CONFIG
// =============================================
const API_BASE = 'https://streamdata.vaplayer.ru/api.php';
const REFERER = 'https://brightpathsignals.com/';
const ORIGIN = 'https://brightpathsignals.com';
const API_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': REFERER,
    'Origin': ORIGIN,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
};

// =============================================
// MANIFEST
// =============================================
const manifest = {
    id: 'community.playimdb.stream',
    version: '1.0.0',
    name: 'PlayIMDB Stream',
    description: 'Watch movies, series, and anime from IMDb directly in Stremio.',
    logo: 'https://images-na.ssl-images-amazon.com/images/G/01/imdb/plugins/rating/imdb_46x22.png',
    background: 'https://www.imdb.com/images/imdbheader-social-2x.png',
    resources: ['stream', 'subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

const builder = new addonBuilder(manifest);

// =============================================
// PARSE ID
// =============================================
function parseId(id) {
    const parts = id.split(':');
    return {
        imdbId: parts[0],
        season: parts[1] || null,
        episode: parts[2] || null
    };
}

// =============================================
// FETCH STREAM DATA
// =============================================
async function fetchStreamData(imdbId, type, season, episode) {
    const params = { imdb: imdbId, type: type };
    if (type === 'tv' && season && episode) {
        params.season = season;
        params.episode = episode;
    }

    try {
        const response = await axios.get(API_BASE, {
            params,
            headers: API_HEADERS,
            timeout: 15000
        });

        if (response.data && response.data.status_code === '200' && response.data.data) {
            return response.data;
        }
        return null;
    } catch (error) {
        console.error('[API] Error:', error.message);
        return null;
    }
}

// =============================================
// SEARCH SUBTITLES
// =============================================
async function searchSubtitles(id, type) {
    const subtitles = [];
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] || null;
    const episode = parts[2] || null;

    try {
        let url = `https://api.subdl.com/auto?imdb_id=${imdbId}&film_type=${type === 'series' ? 'tv' : 'movie'}`;
        if (season) url += `&season_number=${season}`;
        if (episode) url += `&episode_number=${episode}`;

        const response = await axios.get(url, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        if (response.data && response.data.subtitles) {
            for (const sub of response.data.subtitles) {
                if (sub.url) {
                    subtitles.push({
                        id: `subdl-${sub.lang || 'eng'}-${subtitles.length}`,
                        url: sub.url.startsWith('//') ? `https:${sub.url}` : sub.url,
                        lang: mapLang(sub.lang || sub.language || 'eng')
                    });
                }
            }
        }
    } catch (e) {
        // SubDL might fail - ok
    }

    return subtitles;
}

function mapLang(code) {
    const map = {
        'ar':'ara','en':'eng','fr':'fre','es':'spa','de':'ger','it':'ita',
        'pt':'por','ru':'rus','ja':'jpn','ko':'kor','zh':'chi','tr':'tur',
        'hi':'hin','nl':'dut','sv':'swe','pl':'pol','th':'tha','id':'ind',
        'he':'heb','uk':'ukr','ro':'rum','cs':'cze','da':'dan','fi':'fin',
        'el':'gre','hu':'hun','no':'nor','bg':'bul','vi':'vie','ms':'may',
    };
    return map[(code||'').toLowerCase().trim()] || code || 'eng';
}

// =============================================
// QUALITY & CDN HELPERS
// =============================================
function getQuality(url, index, fileName) {
    if (fileName) {
        const m = fileName.match(/(2160|1080|720|480)[pi]/i);
        if (m) return m[1] === '2160' ? '4K' : `${m[1]}p`;
    }
    if (url.includes('master.m3u8') || url.includes('list.m3u8') || url.includes('index.m3u8')) return '1080p';
    return ['1080p','720p','480p','Backup'][index] || `Source ${index+1}`;
}

function getCdn(url) {
    if (url.includes('creativeautomationlab.site')) return 'CDN-1';
    if (url.includes('highperformancebrands.site')) return 'CDN-2';
    if (url.includes('visionaryfounderslab.site')) return 'CDN-3';
    if (url.includes('justhd.tv')) return 'CDN-4';
    if (url.includes('onlinevisibilitysystem.site')) return 'CDN-5';
    return 'CDN';
}

// =============================================
// STREAM HANDLER
// =============================================
builder.defineStreamHandler(async (args) => {
    try {
        const { id, type } = args;
        const parsed = parseId(id);
        const apiType = (type === 'series' || (parsed.season && parsed.episode)) ? 'tv' : 'movie';

        console.log(`[Stream] ${id} type=${apiType}`);

        const data = await fetchStreamData(parsed.imdbId, apiType, parsed.season, parsed.episode);

        if (!data || !data.data || !data.data.stream_urls || data.data.stream_urls.length === 0) {
            return { streams: [] };
        }

        const { stream_urls, file_name } = data.data;
        const referer = 'https://brightpathsignals.com/';

        const streams = stream_urls.map((url, i) => ({
            url: url,
            name: 'PlayIMDB',
            title: `${getQuality(url, i, file_name)}\n${getCdn(url)}${file_name ? ' | ' + file_name.split('/').pop() : ''}`,
            behaviorHints: {
                notWebReady: true,
                filename: file_name ? file_name.split('/').pop() : `${parsed.imdbId}.mkv`,
                bingeGroup: `playimdb-${parsed.imdbId}`,
                proxyHeaders: {
                    request: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': referer,
                        'Origin': 'https://brightpathsignals.com'
                    },
                    response: {}
                }
            }
        }));

        console.log(`[Stream] ${id}: ${streams.length} streams`);
        return { streams };
    } catch (error) {
        console.error('[Stream] Error:', error.message);
        return { streams: [] };
    }
});

// =============================================
// SUBTITLE HANDLER
// =============================================
builder.defineSubtitlesHandler(async (args) => {
    try {
        const { id, type } = args;
        const subtitles = await searchSubtitles(id, type);
        console.log(`[Subtitles] ${id}: ${subtitles.length} subs`);
        return { subtitles };
    } catch (error) {
        console.error('[Subtitles] Error:', error.message);
        return { subtitles: [] };
    }
});

module.exports = { builder };
