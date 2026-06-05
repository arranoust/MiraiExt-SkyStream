(function () {

    // ─── Config ───────────────────────────────────────────────────────────────
    var manifest = { baseUrl: 'https://www.sankavollerei.com' };

    var MAX_RPM          = 45;
    var MIN_INTERVAL     = Math.ceil(60000 / MAX_RPM);
    var CACHE_TTL        = 5 * 60000;
    var STREAM_CACHE_TTL = 30 * 1000; // short TTL for signed/rotating CDN URLs
    var MAX_STREAMS      = 3;

    var HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/json'
    };

    var HOME_CATEGORIES = [
        { key: 'Terbaru',   path: '/anime/samehadaku/recent'    },
        { key: 'Ongoing',   path: '/anime/samehadaku/ongoing'   },
        { key: 'Completed', path: '/anime/samehadaku/completed' },
        { key: 'Movies',    path: '/anime/samehadaku/movies'    }
    ];

    // ─── Rate Limiter ─────────────────────────────────────────────────────────
    var _queue       = [];
    var _running     = false;
    var _lastReqTime = 0;
    var _reqCount    = 0;
    var _windowStart = Date.now();

    function _resetWindow() {
        var now = Date.now();
        if (now - _windowStart >= 60000) { _reqCount = 0; _windowStart = now; }
    }

    function _scheduleNext() {
        if (_running || !_queue.length) return;
        _running = true;
        var task = _queue.shift();
        _resetWindow();

        if (_reqCount >= MAX_RPM) {
            var wait = 60000 - (Date.now() - _windowStart) + 50;
            return setTimeout(function () {
                _running = false;
                _queue.unshift(task);
                _scheduleNext();
            }, wait);
        }

        var delay = Math.max(0, MIN_INTERVAL - (Date.now() - _lastReqTime)) + Math.floor(Math.random() * 200);
        setTimeout(function () {
            _lastReqTime = Date.now();
            _reqCount++;
            task.fn()
                .then(task.resolve)
                .catch(task.reject)
                .finally(function () { _running = false; _scheduleNext(); });
        }, delay);
    }

    // ─── Cache ────────────────────────────────────────────────────────────────
    var _cache = {};

    function _cacheGet(url, ttl) {
        var entry = _cache[url];
        if (!entry || Date.now() - entry.ts > (ttl || CACHE_TTL)) {
            delete _cache[url];
            return null;
        }
        return entry.val;
    }

    function _cachePut(url, val) {
        _cache[url] = { val: val, ts: Date.now() };
        var keys = Object.keys(_cache);
        if (keys.length > 200) {
            delete _cache[keys.sort(function (a, b) { return _cache[a].ts - _cache[b].ts; })[0]];
        }
    }

    function rateLimitedGet(url, hdrs, ttl) {
        var cached = _cacheGet(url, ttl);
        if (cached !== null) return Promise.resolve(cached);
        return new Promise(function (resolve, reject) {
            _queue.push({
                fn: function () {
                    return Promise.resolve(http_get(url, hdrs || HEADERS)).then(function (res) {
                        _cachePut(url, res);
                        return res;
                    });
                },
                resolve: resolve,
                reject:  reject
            });
            _scheduleNext();
        });
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function parseJSON(res) {
        try {
            return typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
        } catch (e) {
            throw new Error('Failed to parse JSON: ' + String(e));
        }
    }

    function toItem(item) {
        return new MultimediaItem({
            title:     String(item.title || 'No Title'),
            url:       manifest.baseUrl + '/anime/samehadaku/anime/' + item.animeId,
            posterUrl: String(item.poster || ''),
            type:      'anime'
        });
    }

    // ─── AniList ──────────────────────────────────────────────────────────────
    async function getAniListData(title) {
        if (!title) return null;
        var query = 'query($s:String){Media(search:$s,type:ANIME){idMal characters(sort:ROLE,perPage:15){edges{role node{name{full native}image{large medium}}}}}}';
        try {
            var res  = await http_post('https://graphql.anilist.co',
                { 'Content-Type': 'application/json', Accept: 'application/json' },
                JSON.stringify({ query: query, variables: { s: title } })
            );
            var data  = typeof res?.body === 'string' ? JSON.parse(res.body) : res?.body;
            var media = data?.data?.Media;
            if (!media) return null;
            return { idMal: media.idMal ? String(media.idMal) : null, characters: media.characters?.edges ?? [] };
        } catch (_) { return null; }
    }

    // ─── AniZip ───────────────────────────────────────────────────────────────
    async function getAniZipByMalId(malId) {
        if (!malId) return null;
        try {
            var res  = await http_get('https://api.ani.zip/mappings?mal_id=' + malId,
                { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' });
            var data = typeof res?.body === 'string' ? JSON.parse(res.body) : res?.body;
            return data?.episodes ? data : null;
        } catch (_) { return null; }
    }

    // ─── Blogger resolver ─────────────────────────────────────────────────────
    async function resolveBlogger(embedUrl) {
        try {
            var res   = await rateLimitedGet(embedUrl, { 'User-Agent': 'Mozilla/5.0' });
            var match = res.body.match(/"play_url"\s*:\s*"([^"]+)"/)
                     || res.body.match(/"iurl"\s*:\s*"([^"]+)"/);
            if (!match) return null;
            return match[1]
                .replace(/\\u003d/g, '=')
                .replace(/\\u0026/g, '&')
                .replace(/\\\//g, '/');
        } catch (_) { return null; }
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var results = await Promise.all(HOME_CATEGORIES.map(async function (cat) {
                try {
                    var res  = await rateLimitedGet(manifest.baseUrl + cat.path);
                    var json = parseJSON(res);
                    var list = (json?.data?.animeList ?? []).map(toItem);
                    return { key: cat.key, list: list };
                } catch (_) { return { key: cat.key, list: [] }; }
            }));

            var data = {};
            results.forEach(function (r) { if (r.list.length) data[r.key] = r.list; });

            if (!Object.keys(data).length)
                return cb({ success: false, error: 'No data from API.' });
            cb({ success: true, data: data });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var res   = await rateLimitedGet(manifest.baseUrl + '/anime/samehadaku/search?q=' + encodeURIComponent(query));
            var json  = parseJSON(res);
            var items = (json?.data?.animeList ?? []).map(toItem);
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var res   = await rateLimitedGet(url);
            var json  = parseJSON(res);
            var anime = json.data || {};

            var animeTitle = String(anime.title || anime.name || '').trim();
            if (!animeTitle) {
                var slug = url.split('/').filter(Boolean).pop() || 'Anime';
                animeTitle = slug.replace(/-/g, ' ').toUpperCase();
            }

            var synopsis    = anime.synopsis?.paragraphs?.join('\n\n') ?? '';
            var animePoster = String(anime.poster || '');
            var episodeList = anime.episodeList || [];

            var searchTitles = [anime.english, animeTitle, anime.japanese].filter(function (t) {
                return t && String(t).trim();
            }).map(String);

            var aniListData = null;
            var aniZip      = null;
            for (var i = 0; i < searchTitles.length; i++) {
                aniListData = await getAniListData(searchTitles[i]);
                if (aniListData?.idMal) break;
            }
            if (aniListData?.idMal) aniZip = await getAniZipByMalId(aniListData.idMal);

            var cast = (aniListData?.characters ?? []).map(function (edge) {
                var node = edge.node;
                if (!node) return null;
                return new Actor({
                    name:  node.name?.full || node.name?.native || 'Unknown',
                    role:  edge.role || 'SUPPORTING',
                    image: node.image?.large || node.image?.medium || ''
                });
            }).filter(Boolean);

            var resolvedTitle = aniZip?.titles?.en || aniZip?.titles?.['x-jat'] || aniZip?.titles?.ja || animeTitle;
            var rawStatus     = String(anime.status || '').toLowerCase();
            var status        = (rawStatus.includes('complet') || rawStatus.includes('tamat')) ? 'completed' : 'ongoing';
            var score         = parseFloat(anime.score || anime.rating || anime.voteAverage || 0) || undefined;

            var episodes = episodeList.slice().reverse().map(function (ep, index) {
                var epNum    = parseFloat(ep.title) || (index + 1);
                var aniEp    = aniZip?.episodes?.[String(ep.title)] || aniZip?.episodes?.[String(Math.floor(epNum))] || null;

                var epName   = aniEp?.title?.en || aniEp?.title?.['x-jat'] || aniEp?.title?.ja || ('Episode ' + ep.title);
                var epPoster = aniEp?.image || (ep.poster ? String(ep.poster) : animePoster);
                var epDesc   = aniEp?.overview ? String(aniEp.overview) : '';

                return new Episode({
                    name:        epName,
                    url:         manifest.baseUrl + '/anime/samehadaku/episode/' + ep.episodeId,
                    season:      1,
                    episode:     epNum,
                    dubStatus:   'subbed',
                    posterUrl:   epPoster,
                    description: epDesc,
                    runtime:     aniEp?.runtime || undefined
                });
            });

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       resolvedTitle,
                    url:         url,
                    posterUrl:   animePoster,
                    type:        'anime',
                    status:      status,
                    score:       score,
                    description: synopsis,
                    cast:        cast,
                    episodes:    episodes
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            // Use short TTL so rotating/signed CDN URLs aren't served stale
            var res    = await rateLimitedGet(url, HEADERS, STREAM_CACHE_TTL);
            var json   = parseJSON(res);
            var epData = json.data || {};
            var streams = [];

            var qualities = epData.server?.qualities ?? [];

            outer:
            for (var qi = 0; qi < qualities.length; qi++) {
                var q = qualities[qi];
                if (!q.title || String(q.title).toLowerCase() === 'unknown') continue;

                for (var si = 0; si < (q.serverList || []).length; si++) {
                    var srv = q.serverList[si];
                    if (!srv.href) continue;

                    try {
                        var srvRes    = await rateLimitedGet(manifest.baseUrl + '/anime' + srv.href, HEADERS, STREAM_CACHE_TTL);
                        var srvJson   = parseJSON(srvRes);
                        var streamUrl = String(srvJson.data?.url || '').trim();
                        if (!streamUrl) continue;

                        var serverName = String(srv.title || '').toLowerCase();
                        var resolved   = null;

                        if (streamUrl.includes('blogger.com/video') || serverName.includes('blogger') || serverName.includes('blogpost')) {
                            resolved = await resolveBlogger(streamUrl);
                            if (resolved) streamUrl = resolved;
                            else continue;
                        } else if (streamUrl.includes('pixeldrain.com/u/') || serverName.includes('pixeldrain')) {
                            streamUrl = streamUrl.replace('pixeldrain.com/u/', 'pixeldrain.com/api/file/');
                        } else if (!streamUrl.includes('wibufile.com') && !serverName.includes('wibufile')) {
                            continue; // skip unsupported hosts
                        }

                        streams.push(new StreamResult({
                            url:     streamUrl,
                            source:  String(srv.title || 'Server'),
                            headers: {
                                Referer:      'https://v2.samehadaku.how/',
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                            }
                        }));
                        break;
                    } catch (_) { continue; }
                }

                if (streams.length >= MAX_STREAMS) break outer;
            }

            if (!streams.length)
                return cb({ success: false, error: 'No playable streams found (Blogger/Wibufile/Pixeldrain).' });

            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams  = loadStreams;

})();