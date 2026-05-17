(function () {

    // ─────────────────────────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────────────────────────
    var MAX_RPM        = 45;
    var MIN_INTERVAL   = Math.ceil(60000 / MAX_RPM); // ~1333 ms antar request
    var CACHE_TTL      = 5 * 60000;  // 5 menit cache per URL
    var MAX_STREAMS    = 3;

    var HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/json'
    };

    // ─────────────────────────────────────────────────────────────────────────
    // RATE LIMITER
    // ─────────────────────────────────────────────────────────────────────────
    var _queue       = [];
    var _running     = false;
    var _lastReqTime = 0;
    var _reqCount    = 0;
    var _windowStart = Date.now();

    function _resetWindowIfNeeded() {
        var now = Date.now();
        if (now - _windowStart >= 60000) {
            _reqCount    = 0;
            _windowStart = now;
        }
    }

    function _scheduleNext() {
        if (_running || _queue.length === 0) return;
        _running = true;

        var task = _queue.shift();
        _resetWindowIfNeeded();

        if (_reqCount >= MAX_RPM) {
            var wait = 60000 - (Date.now() - _windowStart) + 50;
            setTimeout(function () {
                _running = false;
                _queue.unshift(task);
                _scheduleNext();
            }, wait);
            return;
        }

        var now     = Date.now();
        var elapsed = now - _lastReqTime;
        var delay   = elapsed < MIN_INTERVAL ? (MIN_INTERVAL - elapsed + Math.floor(Math.random() * 200)) : 0;

        setTimeout(function () {
            _lastReqTime = Date.now();
            _reqCount++;
            task.fn().then(function (result) {
                task.resolve(result);
            }).catch(function (err) {
                task.reject(err);
            }).finally(function () {
                _running = false;
                _scheduleNext();
            });
        }, delay);
    }

    function rateLimitedGet(url, hdrs) {
        var cached = _cacheGet(url);
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

    // ─────────────────────────────────────────────────────────────────────────
    // IN-MEMORY CACHE
    // ─────────────────────────────────────────────────────────────────────────
    var _cache = {};

    function _cacheGet(url) {
        var entry = _cache[url];
        if (!entry) return null;
        if (Date.now() - entry.ts > CACHE_TTL) {
            delete _cache[url];
            return null;
        }
        return entry.val;
    }

    function _cachePut(url, val) {
        _cache[url] = { val: val, ts: Date.now() };
        var keys = Object.keys(_cache);
        if (keys.length > 200) {
            var oldest = keys.sort(function(a, b) { return _cache[a].ts - _cache[b].ts; })[0];
            delete _cache[oldest];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    function parseJSON(res) {
        try {
            return typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
        } catch (e) {
            throw new Error("Gagal parse JSON: " + String(e));
        }
    }

    function toItem(item, baseUrl) {
        return new MultimediaItem({
            title:     String(item.title || "No Title"),
            url:       baseUrl + "/anime/samehadaku/anime/" + item.animeId,
            posterUrl: String(item.poster || ""),
            type:      'anime'
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ANILIST 
    // ─────────────────────────────────────────────────────────────────────────

    async function getAniListData(title) {
        if (!title) return null;

        var query = [
            'query ($search: String) {',
            '  Media(search: $search, type: ANIME) {',
            '    idMal',
            '    characters(sort: ROLE, perPage: 15) {',
            '      edges {',
            '        role',
            '        node {',
            '          name { full native }',
            '          image { large medium }',
            '        }',
            '      }',
            '    }',
            '  }',
            '}'
        ].join(' ');

        var payload = JSON.stringify({
            query:     query,
            variables: { search: title }
        });

        try {
            var res = await http_post(
                'https://graphql.anilist.co',
                { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                payload
            );
            if (!res || !res.body) return null;
            var data  = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
            var media = data && data.data && data.data.Media;
            if (!media) return null;
            return {
                idMal:      media.idMal ? String(media.idMal) : null,
                characters: media.characters && media.characters.edges
                    ? media.characters.edges
                    : []
            };
        } catch (e) {
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ANIZIP 
    // ─────────────────────────────────────────────────────────────────────────

    async function getAniZipByMalId(malId) {
        if (!malId) return null;
        var url = 'https://api.ani.zip/mappings?mal_id=' + malId;
        try {
            var res = await http_get(url, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' });
            if (!res || !res.body) return null;
            var data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
            return (data && data.episodes) ? data : null;
        } catch (e) {
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Resolver
    // ─────────────────────────────────────────────────────────────────────────
    
    // Blogger
    async function resolveBlogger(embedUrl) {
        try {
            var res = await rateLimitedGet(embedUrl, { "User-Agent": "Mozilla/5.0" });
            if (!res) return null;
            var match = res.body.match(/"play_url"\s*:\s*"([^"]+)"/)
                     || res.body.match(/"iurl"\s*:\s*"([^"]+)"/);
            if (!match) return null;
            return match[1]
                .replace(/\\u003d/g, "=")
                .replace(/\\u0026/g, "&")
                .replace(/\\\//g, "/");
        } catch (_) {
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getHome
    // ─────────────────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var base   = manifest.baseUrl;
            var result = {};

            var categories = [
                { key: "Terbaru",   path: "/anime/samehadaku/recent"    },
                { key: "Ongoing",   path: "/anime/samehadaku/ongoing"   },
                { key: "Completed", path: "/anime/samehadaku/completed" },
                { key: "Movies",    path: "/anime/samehadaku/movies"    }
            ];

            for (var ci = 0; ci < categories.length; ci++) {
                try {
                    var cat  = categories[ci];
                    var res  = await rateLimitedGet(base + cat.path);
                    if (!res) continue;
                    var json = parseJSON(res);
                    var list = ((json.data && json.data.animeList) ? json.data.animeList : [])
                        .map(function (i) { return toItem(i, base); });
                    if (list.length > 0) result[cat.key] = list;
                } catch (_) {}
            }

            if (Object.keys(result).length === 0) {
                cb({ success: false, error: "Tidak ada data dari API." });
                return;
            }
            cb({ success: true, data: result });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // search
    // ─────────────────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var base = manifest.baseUrl;
            var res  = await rateLimitedGet(base + "/anime/samehadaku/search?q=" + encodeURIComponent(query));
            var json = parseJSON(res);
            var items = ((json.data && json.data.animeList) ? json.data.animeList : [])
                .map(function (i) { return toItem(i, base); });
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // load 
    // ─────────────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var base = manifest.baseUrl;
            var res  = await rateLimitedGet(url);

            if (!res || !res.body) {
                cb({ success: false, error: "Respon API kosong atau bermasalah." });
                return;
            }

            var json  = parseJSON(res);
            var anime = json.data || {};

            var animeTitle = "";
            if (anime.title) {
                animeTitle = String(anime.title).trim();
            } else if (anime.name) {
                animeTitle = String(anime.name).trim();
            }
            if (!animeTitle || animeTitle === "undefined" || animeTitle === "") {
                var urlParts = url.split('/');
                var slug     = urlParts[urlParts.length - 1] || "Anime Detail";
                animeTitle   = slug.replace(/-/g, ' ').toUpperCase();
            }

            var synopsis    = (anime.synopsis && anime.synopsis.paragraphs)
                ? anime.synopsis.paragraphs.join("\n\n")
                : "";
            var animePoster = String(anime.poster || "");
            var episodeList = anime.episodeList || [];

            var searchTitles = [];
            if (anime.english && String(anime.english).trim()) {
                searchTitles.push(String(anime.english).trim());
            }
            if (animeTitle) searchTitles.push(animeTitle);
            if (anime.japanese && String(anime.japanese).trim()) {
                searchTitles.push(String(anime.japanese).trim());
            }

            var aniListData = null;
            var aniZip      = null;

            try {
                for (var ti = 0; ti < searchTitles.length; ti++) {
                    aniListData = await getAniListData(searchTitles[ti]);
                    if (aniListData && aniListData.idMal) break;
                }

                if (aniListData && aniListData.idMal) {
                    aniZip = await getAniZipByMalId(aniListData.idMal);
                }
            } catch (_) {
            }

            var cast = [];
            if (aniListData && aniListData.characters.length > 0) {
                cast = aniListData.characters.map(function (edge) {
                    var node = edge.node;
                    if (!node) return null;
                    return new Actor({
                        name:  (node.name && (node.name.full || node.name.native)) || "Unknown",
                        role:  edge.role || "SUPPORTING",
                        image: (node.image && (node.image.large || node.image.medium)) || ""
                    });
                }).filter(function (a) { return a !== null; });
            }

            var episodes = episodeList.slice().reverse().map(function(ep, index) {
                var epNum = parseFloat(ep.title) || (index + 1);

                var epKeyExact = String(ep.title);
                var epKeyFloor = String(Math.floor(epNum));
                var aniEp = null;
                if (aniZip && aniZip.episodes) {
                    aniEp = aniZip.episodes[epKeyExact] || aniZip.episodes[epKeyFloor] || null;
                }

                var epName = "Episode " + ep.title;
                if (aniEp && aniEp.title) {
                    epName = aniEp.title.en
                          || aniEp.title['x-jat']
                          || aniEp.title.ja
                          || epName;
                }

                var epPoster = animePoster;
                if (ep.poster) epPoster = String(ep.poster);
                if (aniEp && aniEp.image) epPoster = aniEp.image;

                var epDesc    = (aniEp && aniEp.overview) ? String(aniEp.overview) : "";
                var epRuntime = (aniEp && aniEp.runtime)  ? aniEp.runtime           : undefined;

                return new Episode({
                    name:        epName,
                    posterUrl:   epPoster,
                    url:         base + "/anime/samehadaku/episode/" + ep.episodeId,
                    season:      1,
                    episode:     epNum,
                    dubStatus:   "subbed",
                    description: epDesc,
                    runtime:     epRuntime
                });
            });

            // Status & Score
            var rawStatus = String(anime.status || "").toLowerCase();
            var status    = rawStatus.includes("complet") || rawStatus.includes("tamat") ? "completed" : "ongoing";
            var score     = parseFloat(anime.score || anime.rating || anime.voteAverage || 0) || undefined;

            // Final title: prefer AniZip English title
            var resolvedTitle = animeTitle;
            if (aniZip && aniZip.titles) {
                resolvedTitle = aniZip.titles.en
                    || aniZip.titles['x-jat']
                    || aniZip.titles.ja
                    || animeTitle;
            }

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
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // loadStreams
    // ─────────────────────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var base    = manifest.baseUrl;
            var res     = await rateLimitedGet(url);
            var json    = parseJSON(res);
            var epData  = json.data || {};
            var streams = [];

            var serverQualities = (epData.server && epData.server.qualities)
                ? epData.server.qualities
                : [];

            outerServer:
            for (var qi = 0; qi < serverQualities.length; qi++) {
                var q      = serverQualities[qi];
                var qTitle = String(q.title || "").toLowerCase();

                if (!q.title || qTitle === "unknown") continue;

                var srvList = q.serverList || [];

                for (var si = 0; si < srvList.length; si++) {
                    var srv = srvList[si];
                    if (!srv.href) continue;

                    try {
                        var srvUrl  = base + "/anime" + srv.href;
                        var srvRes  = await rateLimitedGet(srvUrl);
                        if (!srvRes) continue;

                        var srvJson = parseJSON(srvRes);
                        if (!srvJson.data || !srvJson.data.url) continue;

                        var streamUrl  = String(srvJson.data.url).trim();
                        var serverName = String(srv.title || "").toLowerCase();
                        var isValidSource = false;

                        // ── 1. BLOGGER ──
                        if (streamUrl.indexOf("blogger.com/video") !== -1 || serverName.includes("blogger") || serverName.includes("blogpost")) {
                            var resolvedBlogger = await resolveBlogger(streamUrl);
                            if (resolvedBlogger) {
                                streamUrl     = resolvedBlogger;
                                isValidSource = true;
                            }
                        }

                        // ── 2. PIXELDRAIN ──
                        else if (streamUrl.indexOf("pixeldrain.com/u/") !== -1 || serverName.includes("pixeldrain")) {
                            streamUrl     = streamUrl.replace("pixeldrain.com/u/", "pixeldrain.com/api/file/");
                            isValidSource = true;
                        }

                        // ── 3. WIBUFILE ──
                        else if (streamUrl.indexOf("wibufile.com") !== -1 || serverName.includes("wibufile")) {
                            if (streamUrl.indexOf("http") !== -1) {
                                isValidSource = true;
                            }
                        }

                        if (isValidSource) {
                            streams.push(new StreamResult({
                                url:     streamUrl,
                                source:  String(srv.title || "Server") 
                                headers: {
                                    "Referer":    "https://v2.samehadaku.how/",
                                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                                }
                            }));
                            break;
                        }

                    } catch (_) {
                        continue;
                    }
                }

                if (streams.length >= MAX_STREAMS) break outerServer;
            }

            if (streams.length === 0) {
                cb({ success: false, error: "Tidak ada stream dari Blogger/Wibufile/Pixeldrain yang siap putar." });
                return;
            }

            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams = loadStreams;

})();