(function () {

    var BASE = manifest.baseUrl;
    var TMDB_IMG_W342 = 'https://image.tmdb.org/t/p/w342';
    var TMDB_IMG_W500 = 'https://image.tmdb.org/t/p/w500';
    var TMDB_IMG_ORIG = 'https://image.tmdb.org/t/p/original';
    var TMDB_IMG_W185 = 'https://image.tmdb.org/t/p/w185';
    var TMDB_IMG_W300 = 'https://image.tmdb.org/t/p/w300';
    var UA = 'okhttp/4.12.0';
    var CDN_REFERER = 'https://e2e.majorplay.net/';
    var JSON_HDR = {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Referer': BASE + '/',
        'Origin': BASE
    };

    function headers(extra) {
        var h = {};
        var k;
        for (k in JSON_HDR) h[k] = JSON_HDR[k];
        if (extra) for (k in extra) h[k] = extra[k];
        return h;
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    }

    function parseJSON(res) {
        try {
            var b = getBody(res);
            return typeof b === 'string' ? JSON.parse(b) : b;
        } catch (e) { console.error('Idlix: gagal parse JSON:', e.message); return null; }
    }

    function tmdbImg(path, size) {
        if (!path) return '';
        return path.startsWith('http') ? path : size + path;
    }

    function flatItemToMultimedia(item) {
        if (item.contentType === 'episode') {
            var series = item.series || {};
            var year = (series.firstAirDate || '').split('-')[0];
            return new MultimediaItem({
                title:     (series.title || 'Unknown') + ' E' + item.episodeNumber + (item.name ? ' - ' + item.name : ''),
                url:       BASE + '/api/series/' + series.slug,
                posterUrl: tmdbImg(item.stillPath || series.posterPath, TMDB_IMG_W342),
                type:      'series',
                year:      parseInt(year) || undefined,
                score:     parseFloat(item.voteAverage) || undefined
            });
        }

        var isMovie = item.contentType === 'movie' || (item.contentType == null && item.runtime != null && !item.seasons);
        var apiPath = isMovie ? '/api/movies/' : '/api/series/';
        var year = ((item.releaseDate || item.firstAirDate) || '').split('-')[0];
        return new MultimediaItem({
            title:     item.title || 'Unknown',
            url:       BASE + apiPath + item.slug,
            posterUrl: tmdbImg(item.posterPath, TMDB_IMG_W342),
            type:      isMovie ? 'movie' : 'series',
            year:      parseInt(year) || undefined,
            score:     parseFloat(item.voteAverage) || undefined
        });
    }

    function wrappedItemToMultimedia(entry) {
        var item = entry.content || entry;
        return flatItemToMultimedia(item);
    }

    // ─── getHome ──────────────────────────────────────────────────────────────

    async function getHome(cb) {
        try {
            var json = parseJSON(await http_get(BASE + '/api/homepage', JSON_HDR));
            if (!json) return cb({ success: false, error: 'Failed to load homepage.' });

            var data = {};
            var sections = [].concat(json.above || [], json.below || []);

            sections.forEach(function (section) {
                if (!section.data || !section.data.length) return;
                var title = section.title;
                if (!title) return;

                var items;
                if (section.type === 'featured') {
                    items = section.data.map(wrappedItemToMultimedia);
                } else {
                    items = section.data.map(flatItemToMultimedia);
                }

                items = items.filter(function (i) { return i.title && i.url && !i.url.includes('/undefined'); });
                if (items.length) data[title] = items;
            });

            if (!Object.keys(data).length) return cb({ success: false, error: 'No data from API.' });
            cb({ success: true, data: data });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────

    async function search(query, cb) {
        try {
            var json = parseJSON(await http_get(
                BASE + '/api/search?q=' + encodeURIComponent(query) + '&page=1&limit=20',
                JSON_HDR
            ));
            var items = (json && json.results ? json.results : []).map(flatItemToMultimedia);
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────

    async function load(url, cb) {
        try {
            var data = parseJSON(await http_get(url, JSON_HDR));
            if (!data) return cb({ success: false, error: 'Invalid API response.' });

            var title    = data.title || 'Unknown';
            var poster   = tmdbImg(data.posterPath, TMDB_IMG_W500);
            var banner   = tmdbImg(data.backdropPath, TMDB_IMG_ORIG);
            var logo     = tmdbImg(data.logoPath, TMDB_IMG_ORIG);
            var year     = parseInt(((data.releaseDate || data.firstAirDate) || '').split('-')[0]) || undefined;
            var score    = parseFloat(data.voteAverage) || undefined;
            var isMovie  = !data.seasons;

            var cast = (data.cast || []).map(function (c) {
                return new Actor({
                    name:  c.name || 'Unknown',
                    role:  c.character || '',
                    image: tmdbImg(c.profilePath, TMDB_IMG_W185)
                });
            });

            var trailers = data.trailerUrl ? [new Trailer({ url: data.trailerUrl })] : [];

            var syncData = {};
            if (data.tmdbId) syncData.tmdb = String(data.tmdbId);

            var recommendations = [];
            try {
                var relPath = (isMovie ? '/api/movies/' : '/api/series/') + data.slug + '/related';
                var relJson = parseJSON(await http_get(BASE + relPath, JSON_HDR));
                recommendations = (relJson && relJson.data ? relJson.data : []).map(flatItemToMultimedia);
            } catch (e) { console.error('Idlix: gagal memuat rekomendasi:', e.message); }

            if (isMovie) {
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title, url, posterUrl: poster, bannerUrl: banner, logoUrl: logo,
                        type: 'movie', year, score,
                        status: data.status || undefined,
                        description: data.overview || '',
                        cast, trailers, recommendations,
                        syncData: Object.keys(syncData).length ? syncData : undefined,
                        episodes: [new Episode({
                            name:    title,
                            url:     JSON.stringify({ id: data.id, type: 'movie' }),
                            season:  1,
                            episode: 1,
                            posterUrl: poster,
                            runtime: data.runtime || undefined
                        })]
                    })
                });
            } else {
                var episodes = [];

                function mapEpisode(ep, seasonNum) {
                    return new Episode({
                        name:        ep.name || ('Episode ' + ep.episodeNumber),
                        url:         JSON.stringify({ id: ep.id, type: 'episode' }),
                        season:      seasonNum,
                        episode:     ep.episodeNumber || 1,
                        description: ep.overview || '',
                        airDate:     ep.airDate || '',
                        runtime:     ep.runtime || undefined,
                        posterUrl:   tmdbImg(ep.stillPath, TMDB_IMG_W300)
                    });
                }

                var firstSeasonNum = data.firstSeason && data.firstSeason.seasonNumber;
                if (data.firstSeason && data.firstSeason.episodes) {
                    data.firstSeason.episodes.forEach(function (ep) {
                        if (ep.id) episodes.push(mapEpisode(ep, firstSeasonNum || 1));
                    });
                }

                var otherSeasons = (data.seasons || []).filter(function (s) {
                    return s.seasonNumber && s.seasonNumber !== firstSeasonNum;
                });

                var seasonResults = await Promise.all(otherSeasons.map(async function (s) {
                    try {
                        var sJson = parseJSON(await http_get(
                            BASE + '/api/series/' + data.slug + '/season/' + s.seasonNumber,
                            JSON_HDR
                        ));
                        var season = sJson && sJson.season ? sJson.season : null;
                        if (!season || !season.episodes) return [];
                        return season.episodes
                            .filter(function (ep) { return ep.id; })
                            .map(function (ep) { return mapEpisode(ep, s.seasonNumber); });
                    } catch (e) { console.error('Idlix: gagal memuat season ' + s.seasonNumber + ':', e.message); return []; }
                }));

                seasonResults.forEach(function (eps) { episodes = episodes.concat(eps); });
                episodes.sort(function (a, b) {
                    if (a.season !== b.season) return a.season - b.season;
                    return a.episode - b.episode;
                });

                cb({
                    success: true,
                    data: new MultimediaItem({
                        title, url, posterUrl: poster, bannerUrl: banner, logoUrl: logo,
                        type: 'series', year, score,
                        status: data.status || undefined,
                        description: data.overview || '',
                        cast, trailers, recommendations,
                        syncData: Object.keys(syncData).length ? syncData : undefined,
                        episodes
                    })
                });
            }
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────

    async function loadStreams(url, cb) {
        try {
            var parsed = JSON.parse(url);
            var contentId   = parsed.id;
            var contentType = parsed.type;
            if (!contentId) return cb({ success: false, error: 'Missing content ID.' });

            var hdrs = headers({ 'Content-Type': 'application/json' });

            // Step 1: get gate token
            var playRes  = await http_get(BASE + '/api/watch/play-info/' + contentType + '/' + contentId, hdrs);
            var playInfo = parseJSON(playRes);
            if (!playInfo || !playInfo.gateToken) return cb({ success: false, error: 'Failed to get gate token.' });

            // Extract did cookie
            var didCookie = '';
            var setCookie = playRes.headers && playRes.headers['set-cookie'];
            var m = null;
            if (Array.isArray(setCookie) && setCookie.length) {
                var last = setCookie[setCookie.length - 1];
                m = last.match(/did=([a-f0-9]+)/);
                if (m) didCookie = 'did=' + m[1];
            } else if (typeof setCookie === 'string') {
                m = setCookie.match(/did=([a-f0-9]+)/);
                if (m) didCookie = 'did=' + m[1];
            }

            // Step 2: wait for unlock
            var waitMs = Math.max(0, (playInfo.unlockAt || 0) - (playInfo.serverNow || Date.now()));
            if (waitMs > 0) await new Promise(function (r) { setTimeout(r, waitMs + 500); });

            // Step 3: claim session (with cookie)
            var claimHeaders = headers({ 'Content-Type': 'application/json' });
            if (didCookie) claimHeaders['Cookie'] = didCookie;
            var claimRaw = await http_post(BASE + '/api/watch/session/claim', claimHeaders, JSON.stringify({ gateToken: playInfo.gateToken }));
            var claimRes = parseJSON(claimRaw);
            if (!claimRes || !claimRes.claim) return cb({ success: false, error: 'claim failed: ' + JSON.stringify(claimRes) });

            // Step 4: redeem
            var redeemRaw = await http_post(claimRes.redeemUrl, hdrs, JSON.stringify({ claim: claimRes.claim }));
            var redeemRes = parseJSON(redeemRaw);
            if (!redeemRes || !redeemRes.url) return cb({ success: false, error: 'redeem failed: ' + JSON.stringify(redeemRes) });

            var subtitles = (redeemRes.subtitles || []).map(function (s) {
                return { url: s.path, label: s.label, lang: s.lang || 'und' };
            });

            var quality = playInfo.maxHeight ? playInfo.maxHeight + 'p' : 'Auto';
            cb({
                success: true,
                data: [new StreamResult({
                    url:       redeemRes.url,
                    quality:   quality,
                    source:    'Idlix',
                    headers:   { Referer: CDN_REFERER, Origin: BASE, 'User-Agent': UA },
                    subtitles: subtitles.length ? subtitles : undefined
                })]
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();