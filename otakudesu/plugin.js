(function () {

    // ─────────────────────────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────────────────────────
    var MAX_RPM      = 40;                          
    var MIN_INTERVAL = Math.ceil(60000 / MAX_RPM);  
    var CACHE_TTL    = 5 * 60000;                   
    var MAX_STREAMS  = 3;

    var SERVER_PRIORITY = ["filedon", "ondesu", "blogger", "desustream", "vidhide"];

    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    var JSON_HEADERS = { 'User-Agent': UA, 'Accept': 'application/json' };
    var HTML_HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

    // ─────────────────────────────────────────────────────────────────────────
    // RATE LIMITER 
    // ─────────────────────────────────────────────────────────────────────────
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
        if (_running || _queue.length === 0) return;
        _running = true;
        var task = _queue.shift();
        _resetWindow();

        if (_reqCount >= MAX_RPM) {
            var wait = 60000 - (Date.now() - _windowStart) + 200;
            setTimeout(function () { _running = false; _queue.unshift(task); _scheduleNext(); }, wait);
            return;
        }

        var elapsed = Date.now() - _lastReqTime;
        var delay   = elapsed < MIN_INTERVAL ? (MIN_INTERVAL - elapsed + Math.floor(Math.random() * 100)) : 0;

        setTimeout(function () {
            _lastReqTime = Date.now();
            _reqCount++;
            task.fn()
                .then(task.resolve)
                .catch(task.reject)
                .finally(function () { _running = false; _scheduleNext(); });
        }, delay);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IN-MEMORY CACHE 
    // ─────────────────────────────────────────────────────────────────────────
    var _cache = {};

    function _cacheGet(url) {
        var e = _cache[url];
        if (!e) return null;
        if (Date.now() - e.ts > CACHE_TTL) { delete _cache[url]; return null; }
        return e.val;
    }

    function _cachePut(url, val) {
        _cache[url] = { val: val, ts: Date.now() };
        var keys = Object.keys(_cache);
        if (keys.length > 200) {
            delete _cache[keys.sort(function (a, b) { return _cache[a].ts - _cache[b].ts; })[0]];
        }
    }

    function rateLimitedGet(url, hdrs) {
        var cached = _cacheGet(url);
        if (cached !== null) return Promise.resolve(cached);
        return new Promise(function (resolve, reject) {
            _queue.push({
                fn: function () {
                    return Promise.resolve(http_get(url, hdrs || JSON_HEADERS)).then(function (res) {
                        _cachePut(url, res); return res;
                    });
                },
                resolve: resolve, reject: reject
            });
            _scheduleNext();
        });
    }

    function rawGet(url, hdrs) {
        return new Promise(function (resolve, reject) {
            _queue.push({
                fn: function () { return Promise.resolve(http_get(url, hdrs || JSON_HEADERS)); },
                resolve: resolve, reject: reject
            });
            _scheduleNext();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────
    function parseJSON(res) {
        try { return typeof res.body === 'string' ? JSON.parse(res.body) : res.body; }
        catch (e) { throw new Error("Gagal parse JSON: " + String(e)); }
    }

    function getBody(res) {
        if (!res) return "";
        if (typeof res === "string") return res;
        if (typeof res.body === "string") return res.body;
        return String(res.body || "");
    }

    function toItem(item, baseUrl) {
        return new MultimediaItem({
            title:     String(item.title || "No Title"),
            url:       baseUrl + item.href,
            posterUrl: String(item.poster || ""),
            type:      'anime'
        });
    }

    function sortServers(list) {
        return list.slice().sort(function (a, b) {
            var an = String(a.title || "").toLowerCase().trim();
            var bn = String(b.title || "").toLowerCase().trim();
            function rank(n) {
                for (var i = 0; i < SERVER_PRIORITY.length; i++) {
                    if (n.includes(SERVER_PRIORITY[i])) return i;
                }
                return 999;
            }
            return rank(an) - rank(bn);
        });
    }

    function isPlayable(url) {
        return /\.(mp4|m3u8|webm)/i.test(url)
            || url.indexOf('X-Amz')               !== -1
            || url.indexOf('cloudflarestorage')    !== -1
            || url.indexOf('googlevideo')          !== -1
            || url.indexOf('archive.org/download') !== -1;
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
    // STREAM RESOLVERS
    // ─────────────────────────────────────────────────────────────────────────

    // Filedon
    async function resolveFiledon(embedUrl) {
        try {
            var res  = await rawGet(embedUrl, Object.assign({}, HTML_HEADERS, { 'Referer': 'https://otakudesu.blog/' }));
            var body = getBody(res);
            if (!body) return null;

            var m = body.match(/data-page="([^"]+)"/);
            if (!m) return null;

            var page = JSON.parse(
                m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                    .replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            );

            var mp4 = page.props && page.props.url;
            if (!mp4 || typeof mp4 !== 'string') return null;
            if (!isPlayable(mp4) && mp4.indexOf('.r2.') === -1) return null;

            return { url: mp4, referer: 'https://filedon.co/' };
        } catch (_) { return null; }
    }

    // Ondesu
    async function resolveOndesu(embedUrl, episodeReferer) {
        try {
            var res  = await rawGet(embedUrl, Object.assign({}, HTML_HEADERS, { 'Referer': episodeReferer }));
            var body = getBody(res);
            if (!body) return null;

            // Cari iframe src yang berisi Blogger URL
            var m = body.match(/<iframe[^>]+src=["']([^"']*draft\.blogger\.com[^"']*)["']/i)
                 || body.match(/<iframe[^>]+src=["'](https?:\/\/[^"']*blogger\.com\/video[^"']*)["']/i)
                 || body.match(/src=["'](https?:\/\/[^"']+blogger[^"']*)["']/i);

            if (!m || !m[1]) return null;
            var bloggerUrl = m[1];

            // Sudah googlevideo — tidak perlu resolve lagi
            if (bloggerUrl.indexOf('googlevideo.com') !== -1) {
                return { url: bloggerUrl, referer: 'https://www.blogger.com/' };
            }

            return await resolveBlogger(bloggerUrl);
        } catch (_) { return null; }
    }

    // Blogger
    async function resolveBlogger(embedUrl) {
        try {
            var res  = await rawGet(embedUrl, { 'User-Agent': UA });
            var body = getBody(res);
            if (!body) return null;

            var m = body.match(/"play_url"\s*:\s*"([^"]+)"/)
                 || body.match(/"iurl"\s*:\s*"([^"]+)"/);
            if (!m) return null;

            var streamUrl = m[1]
                .replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/');

            return { url: streamUrl, referer: 'https://www.blogger.com/' };
        } catch (_) { return null; }
    }

    //VidHide
    async function resolveVidHide(embedUrl, episodeReferer) {
        try {
            var res  = await rawGet(embedUrl, Object.assign({}, HTML_HEADERS, { 'Referer': episodeReferer }));
            var body = getBody(res);
            if (!body) return null;

            var origin = '';
            try { origin = 'https://' + new URL(embedUrl).hostname + '/'; } catch (_) {}

            var m = body.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,300}?)["']/i);
            if (m && m[1]) return { url: m[1], referer: origin };

            var packMatch = body.match(/\}\s*\('([\s\S]+?)',\s*(\d+)\s*,\s*\d+\s*,\s*'([\s\S]+?)'\.split\('\|'\)\s*\)/);
            if (packMatch) {
                var words = packMatch[3].split('|');

                for (var wi = 0; wi < words.length; wi++) {
                    var w = words[wi];
                    if (w.length > 10 && (/\.m3u8/i.test(w) || /\.mp4/i.test(w))) {
                        if (!w.startsWith('http')) w = 'https://' + w;
                        return { url: w, referer: origin };
                    }
                }

                var cdnFragments = words.filter(function (w) {
                    return w.length > 5 && (
                        w.indexOf('cdn') !== -1 || w.indexOf('stream') !== -1 ||
                        w.indexOf('video') !== -1 || w.indexOf('media') !== -1
                    );
                });

                for (var ci = 0; ci < cdnFragments.length; ci++) {
                    var idx = words.indexOf(cdnFragments[ci]);
                    if (idx >= 0 && idx + 1 < words.length) {
                        var combined = cdnFragments[ci] + '/' + words[idx + 1];
                        if (/\.m3u8|\.mp4/i.test(combined)) {
                            if (!combined.startsWith('http')) combined = 'https://' + combined;
                            return { url: combined, referer: origin };
                        }
                    }
                }
            }

            m = body.match(/["'](https?:\/\/[^"']{15,}\.(?:mp4|m3u8|webm)[^"']{0,300}?)["']/i);
            if (m && m[1]) return { url: m[1], referer: origin };

            return null;
        } catch (_) { return null; }
    }

    // Desustream
    async function resolveDesustream(embedUrl, episodeReferer) {
        try {
            var res  = await rawGet(embedUrl, Object.assign({}, HTML_HEADERS, { 'Referer': episodeReferer }));
            var body = getBody(res);
            if (!body) return null;

            var m =
                body.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                body.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                body.match(/src\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
                body.match(/["'](https?:\/\/[^"']{15,}\.(?:mp4|m3u8)[^"']{0,300}?)["']/i);

            if (!m || !m[1]) return null;

            var ref = m[1].indexOf('archive.org') !== -1 ? 'https://archive.org/' : '';
            try { if (!ref) ref = new URL(embedUrl).origin + '/'; } catch (_) { ref = episodeReferer; }

            return { url: m[1], referer: ref };
        } catch (_) { return null; }
    }

    // Any Resolve
    async function resolveAny(embedUrl, serverName, episodeReferer) {
        try {
            if (/\.(mp4|m3u8|webm)(\?|$)/i.test(embedUrl)) {
                try { return { url: embedUrl, referer: new URL(embedUrl).origin + '/' }; }
                catch (_) { return { url: embedUrl, referer: episodeReferer }; }
            }
            if (embedUrl.indexOf('archive.org')   !== -1) return { url: embedUrl, referer: 'https://archive.org/' };
            if (embedUrl.indexOf('googlevideo')    !== -1) return { url: embedUrl, referer: 'https://www.blogger.com/' };
            if (embedUrl.indexOf('filedon')        !== -1 || serverName.includes('filedon'))    return await resolveFiledon(embedUrl);
            if (embedUrl.indexOf('blogger.com/video') !== -1 || serverName.includes('blogger')) return await resolveBlogger(embedUrl);
            if (embedUrl.indexOf('ondesu')         !== -1 || serverName.includes('ondesu'))     return await resolveOndesu(embedUrl, episodeReferer);
            if (embedUrl.indexOf('vidhide')        !== -1 || embedUrl.indexOf('odvidhide') !== -1
                || serverName.includes('vidhide'))                                               return await resolveVidHide(embedUrl, episodeReferer);
            return await resolveDesustream(embedUrl, episodeReferer);
        } catch (_) { return null; }
    }

    function getLabel(streamUrl, serverName) {
        if (streamUrl.indexOf('cloudflarestorage') !== -1 || streamUrl.indexOf('filedon') !== -1) return 'Filedon';
        if (streamUrl.indexOf('archive.org')       !== -1) return 'Archive';
        if (streamUrl.indexOf('googlevideo')        !== -1) return 'Blogger';
        if (serverName.includes('vidhide'))                 return 'VidHide';
        if (serverName.includes('ondesu'))                  return 'OnDesu';
        if (serverName.includes('filedon'))                 return 'Filedon';
        if (serverName.includes('otakuwatch'))              return 'OtakuWatch';
        if (serverName.includes('odstream'))                return 'ODStream';
        return 'Stream';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CORE EXTENSION METHODS
    // ─────────────────────────────────────────────────────────────────────────

    // Home
    async function getHome(cb) {
        try {
            var base = manifest.baseUrl, result = {};
            try {
                var rh = await rateLimitedGet(base + '/anime/home');
                var jh = parseJSON(rh), hd = jh.data || {};
                var ol = hd.ongoing  && hd.ongoing.animeList  ? hd.ongoing.animeList  : [];
                var cl = hd.complete && hd.complete.animeList ? hd.complete.animeList : [];
                if (ol.length > 0) result['Ongoing']   = ol.map(function (i) { return toItem(i, base); });
                if (cl.length > 0) result['Completed'] = cl.map(function (i) { return toItem(i, base); });
            } catch (_) {}

            var fallbacks = [
                { key: 'Ongoing',   path: '/anime/ongoing-anime'  },
                { key: 'Completed', path: '/anime/complete-anime' }
            ];
            for (var fi = 0; fi < fallbacks.length; fi++) {
                var cat = fallbacks[fi];
                if (result[cat.key]) continue;
                try {
                    var r  = await rateLimitedGet(base + cat.path);
                    var j  = parseJSON(r);
                    var ls = (j.data && j.data.animeList ? j.data.animeList : [])
                        .map(function (i) { return toItem(i, base); });
                    if (ls.length > 0) result[cat.key] = ls;
                } catch (_) {}
            }

            if (Object.keys(result).length === 0) { cb({ success: false, error: 'Tidak ada data.' }); return; }
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // Search
    async function search(query, cb) {
        try {
            var base  = manifest.baseUrl;
            var res   = await rateLimitedGet(base + '/anime/search/' + encodeURIComponent(query));
            var json  = parseJSON(res);
            var items = (json.data && json.data.animeList ? json.data.animeList : [])
                .map(function (i) { return toItem(i, base); });
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // Load Anime
    async function load(url, cb) {
        try {
            var res   = await rateLimitedGet(url);
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
                    name:      epName,
                    posterUrl: epPoster,
                    url:       manifest.baseUrl + ep.href + ep.episodeId,
                    season:    1,
                    episode:   epNum,
                    dubStatus: 'subbed',
                    description: epDesc,
                    runtime:     epRuntime
                });
            });

            // Status & Score
            var rawStatus = String(anime.status || '').toLowerCase();
            var status    = rawStatus.includes('complet') || rawStatus.includes('tamat') ? 'completed' : 'ongoing';
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

    // Load Streams
    async function loadStreams(url, cb) {
        try {
            var base = manifest.baseUrl;

            var budget = 12;

            // Fetch episode data
            budget--;
            var res    = await rawGet(url, JSON_HEADERS);
            var json   = parseJSON(res);
            var epData = json.data || {};

            var episodeReferer = epData.otakudesuUrl
                ? String(epData.otakudesuUrl)
                : 'https://otakudesu.blog/';

            var serverQualities = epData.server && epData.server.qualities
                ? epData.server.qualities : [];

            // Sort kualitas
            var qOrder = { '720p': 0, '480p': 1, '360p': 2 };
            var sortedQ = serverQualities.slice().sort(function (a, b) {
                var ai = qOrder[a.title] !== undefined ? qOrder[a.title] : 99;
                var bi = qOrder[b.title] !== undefined ? qOrder[b.title] : 99;
                return ai - bi;
            });

            var streams = [];

            outerQ:
            for (var qi = 0; qi < sortedQ.length; qi++) {
                var q      = sortedQ[qi];
                var qTitle = String(q.title || '').trim();
                if (!qTitle || qTitle.toLowerCase() === 'unknown') continue;
                if (!q.serverList || q.serverList.length === 0)    continue;

                if (budget < 2) break outerQ;

                var sortedSrv = sortServers(q.serverList);

                for (var si = 0; si < sortedSrv.length; si++) {
                    if (budget < 2) break outerQ;

                    var srv        = sortedSrv[si];
                    var serverName = String(srv.title || '').toLowerCase().trim();
                    var srvPath    = srv.href
                        ? (base + srv.href)
                        : (base + '/anime/server/' + srv.serverId);

                    try {

                        budget--;
                        var srvRes  = await rawGet(srvPath, JSON_HEADERS);
                        if (!srvRes) { budget++; continue; }

                        var srvJson = parseJSON(srvRes);
                        if (!srvJson.data || !srvJson.data.url) continue;

                        var embedUrl = String(srvJson.data.url).trim();
                        if (!embedUrl) continue;

                        budget--;
                        var resolved = await resolveAny(embedUrl, serverName, episodeReferer);

                        if (!resolved || !resolved.url || !isPlayable(resolved.url)) {
                            budget++; 
                            continue;
                        }

                        streams.push(new StreamResult({
                            url:     resolved.url,
                            source:  getLabel(resolved.url, serverName) + ' [' + qTitle + ']',
                            headers: { 'User-Agent': UA, 'Referer': resolved.referer }
                        }));

                        break; 

                    } catch (_) { budget++; continue; }
                }

                if (streams.length >= MAX_STREAMS) break outerQ;
            }

            if (streams.length === 0) {
                cb({ success: false, error: 'Gagal mengekstrak stream video.' });
                return;
            }
            cb({ success: true, data: streams });

        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPOSE
    // ─────────────────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams = loadStreams;

})();