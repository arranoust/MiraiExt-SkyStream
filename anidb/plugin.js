(function () {

    var BASE = manifest.baseUrl;
    var UA = 'okhttp/4.12.0';
    var HTML_HDR = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    var API_HDR  = { 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: BASE + '/' };

    var HOME_CATEGORIES = [
        { name: 'Trending',          url: BASE + '/browse?sort=order_trending' },
        { name: 'Top Airing',        url: BASE + '/browse?sort=order_top_airing' },
        { name: 'Most Popular',      url: BASE + '/browse?sort=order_popular' },
        { name: 'Fan Favorites',     url: BASE + '/browse?sort=order_favorite' },
        { name: 'Latest Updates',    url: BASE + '/browse?sort=order_updated' },
        { name: 'Currently Airing',  url: BASE + '/browse?sort=order_top_airing&status=Currently+Airing' },
        { name: 'Top TV',            url: BASE + '/browse?type=TV&sort=order_top' },
        { name: 'Top Movie',         url: BASE + '/browse?type=Movie&sort=order_top' },
        { name: 'Top OVA',           url: BASE + '/browse?type=OVA&sort=order_top' },
        { name: 'Top ONA',           url: BASE + '/browse?type=ONA&sort=order_top' },
        { name: 'Top Special',       url: BASE + '/browse?type=Special&sort=order_top' },
        { name: 'Completed TV',      url: BASE + '/browse?type=TV&status=Finished+Airing&sort=order_updated' }
    ];

    // ─── Helpers ──────────────────────────────────────────────────────────────

    async function parseHtml(html, selector, attr) {
        try {
            var raw = await parse_html(html, selector, attr);
            if (!Array.isArray(raw)) return [];
            return raw.map(function (item) {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (attr === 'text') return item.text || '';
                return item.attr || item[attr] || '';
            });
        } catch (_) { return []; }
    }

    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    }

    function parseJSON(res) {
        try { var b = getBody(res); return typeof b === 'string' ? JSON.parse(b) : b; }
        catch (_) { return null; }
    }

    function extractSiteId(url) {
        var m = url.match(/-(\d+)(?:\/|$)/);
        return m ? m[1] : null;
    }

    function extractM3u8(src) {
        var patterns = [
            /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
            /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
            /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i,
            /["'](https?:\/\/[^"']+\.m3u8[^"']{0,300}?)["']/i
        ];
        for (var i = 0; i < patterns.length; i++) {
            var m = src.match(patterns[i]);
            if (m) return m[1];
        }
        return null;
    }

    // ─── HLS variant parser ───────────────────────────────────────────────────

    function resolveUrl(base, relative) {
        if (!relative) return base;
        if (relative.indexOf('http') === 0) return relative;
        if (relative.indexOf('//') === 0) return 'https:' + relative;
        if (relative.indexOf('/') === 0) {
            var end = base.indexOf('://') + 3;
            var hostEnd = base.indexOf('/', end);
            if (hostEnd === -1) hostEnd = base.length;
            return base.slice(0, hostEnd) + relative;
        }
        var slash = base.lastIndexOf('/');
        return (slash > 8 ? base.slice(0, slash + 1) : base + '/') + relative;
    }

    function parseHlsVariants(content, baseUrl) {
        if (!content || content.indexOf('#EXTM3U') === -1) return null;
        var variants = [], lines = content.split('\n'), inf = null, hasStreamInf = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
                hasStreamInf = true;
                var resM = line.match(/RESOLUTION=(\d+)x(\d+)/);
                var bwM  = line.match(/[^-]BANDWIDTH=(\d+)\b/);
                inf = { height: resM ? parseInt(resM[2], 10) : 0, bandwidth: bwM ? parseInt(bwM[1], 10) : 0 };
            } else if (line.indexOf('#') === 0) {
                continue;
            } else if (inf) {
                var vUrl = line.indexOf('http') === 0 ? line : resolveUrl(baseUrl, line);
                var h = inf.height;
                var label = h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 480 ? '480p' : h >= 360 ? '360p' : (h ? h + 'p' : 'Auto');
                variants.push({ url: vUrl, height: h, bandwidth: inf.bandwidth, label: label });
                inf = null;
            }
        }
        variants.sort(function (a, b) { return b.height - a.height; });
        return variants.length > 0 && hasStreamInf ? variants : null;
    }

    // ─── Parallel HTTP ────────────────────────────────────────────────────────

    async function httpParallelGet(requests) {
        if (!requests.length) return [];
        if (typeof http_parallel === 'function') {
            try {
                var res = await http_parallel(requests.map(function (r) {
                    return { method: 'GET', url: r.url, headers: r.headers || HTML_HDR };
                }));
                return requests.map(function (r, i) {
                    var item = res && res[i];
                    return { body: String((item && (item.body || item.text)) || ''), url: r.url };
                });
            } catch (_) {}
        }
        return Promise.all(requests.map(function (r) {
            return http_get(r.url, r.headers || HTML_HDR)
                .then(function (item) { return { body: getBody(item), url: r.url }; })
                .catch(function () { return { body: '', url: r.url }; });
        }));
    }

    // ─── Card Parser ──────────────────────────────────────────────────────────

    async function parseCards(html) {
        if (!html || html.length < 500) return [];

        var results = [];
        var blocks = html.split(/<a\b([^>]*class="[^"]*anime-card[^"]*"[^>]*)>/i);

        for (var i = 1; i < blocks.length; i += 2) {
            var attrs = blocks[i];
            var inner = blocks[i + 1] || '';

            var hrefM = attrs.match(/\bhref="([^"]+)"/i);
            var titleM = attrs.match(/\btitle="([^"]+)"/i);
            if (!hrefM || !titleM) continue;

            var url = hrefM[1];
            var title = titleM[1];

            var imgM = inner.match(/<img\b[^>]*\bsrc="([^"]+)"/i);
            var poster = '';
            if (imgM && !imgM[1].includes('placeholder')) {
                poster = imgM[1];
            }

            var scoreM = inner.match(/badge-gray[^>]*>(?:\s*<[^>]*>\s*)*([0-9]+(?:\.[0-9]+)?)/);
            var score = scoreM ? parseFloat(scoreM[1]) : undefined;

            results.push(new MultimediaItem({
                title:     title.trim(),
                url:       url,
                posterUrl: poster,
                type:      'anime',
                score:     score
            }));
        }

        return results;
    }

    // ─── Episode Parser ───────────────────────────────────────────────────────

    var SUB_CODES = ['jpn', 'ja', 'japanese'];
    var DUB_CODES = ['eng', 'en', 'english'];

    function classifyLanguage(lang) {
        var code = (lang.code || '').toLowerCase();
        var name = (lang.name || '').toLowerCase();
        if (SUB_CODES.indexOf(code) !== -1 || SUB_CODES.indexOf(name) !== -1) return 'sub';
        if (DUB_CODES.indexOf(code) !== -1 || DUB_CODES.indexOf(name) !== -1) return 'dub';
        return null;
    }

    function parseEpisodes(episodes, animeUrl, aniZip, dubStatus, typeParam) {
        if (!episodes || !episodes.length) return [];

        var suffix = typeParam ? '?type=' + typeParam : '';
        var results = [];
        for (var i = 0; i < episodes.length; i++) {
            var ep = episodes[i];
            var num = ep.number || (i + 1);
            var epMeta = aniZip && aniZip.episodes && aniZip.episodes[String(num)];

            var epName = 'Episode ' + num;
            if (epMeta) {
                var metaTitle = epMeta.title && (epMeta.title.en || epMeta.title['x-jat'] || epMeta.title.ja);
                if (metaTitle) epName = metaTitle;
            }

            var epPoster = (epMeta && epMeta.image) || '';
            var epDesc = (epMeta && epMeta.overview) || '';
            var epAir = (epMeta && (epMeta.airDateUtc || epMeta.airdate)) || '';

            results.push(new Episode({
                name:       epName,
                url:        animeUrl + '/' + ep.number + suffix,
                season:     1,
                episode:    num,
                posterUrl:  epPoster,
                description: epDesc,
                airDate:    epAir ? epAir.substring(0, 10) : '',
                dubStatus:  dubStatus || 'none'
            }));
        }

        return results;
    }

    // ─── getHome ──────────────────────────────────────────────────────────────

    async function getHome(cb) {
        try {
            var result = {};
            await Promise.all(HOME_CATEGORIES.map(async function (cat) {
                try {
                    var res = await http_get(cat.url, HTML_HDR);
                    var html = getBody(res);
                    if (!html) return;
                    var items = await parseCards(html);
                    if (items.length) result[cat.name] = items;
                } catch (e) {
                    console.error('Failed to load category: ' + cat.name, e);
                }
            }));
            if (!Object.keys(result).length) return cb({ success: false, error: 'Failed to load homepage.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────

    async function search(query, cb) {
        try {
            var html = getBody(await http_get(BASE + '/browse?q=' + encodeURIComponent(query), HTML_HDR));
            var items = await parseCards(html);
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────

    async function load(url, cb) {
        try {
            var siteId = extractSiteId(url);
            if (!siteId) return cb({ success: false, error: 'Could not extract siteId from URL.' });

            var html = getBody(await http_get(url, HTML_HDR));

            var titleArr = await parseHtml(html, 'h1', 'text');
            var title = (titleArr[0] || '').trim() || siteId;

            var posterArr = await parseHtml(html, 'div.flex-shrink-0 img', 'src');
            var ogImg = await parseHtml(html, 'meta[property="og:image"]', 'content');
            var poster = posterArr[0] || ogImg[0] || '';

            var descArr = await parseHtml(html, 'meta[name="description"]', 'content');
            var desc = (descArr[0] || '').trim();

            var tags = await parseHtml(html, 'a.filter-chip', 'text');

            var yearM = html.match(/browse\?[^"']*year=(\d{4})/);
            var year = yearM ? parseInt(yearM[1]) : undefined;

            var scoreM = html.match(/badge-gray[^>]*>[\s\S]*?([0-9]+(?:\.[0-9]+)?)\s*<\/span>/);
            var score = scoreM ? parseFloat(scoreM[1]) : undefined;

            var statusM = html.match(/browse\?status=([^"'&]+)/);
            var status = statusM ? decodeURIComponent(statusM[1]) : '';
            var mappedStatus = status.includes('Currently') ? 'ongoing' : status.includes('Finished') ? 'completed' : undefined;

            var isMovie = /browse\?type=Movie/i.test(html);

            var trailerM = html.match(/href="(https?:\/\/(?:www\.)?youtube\.com\/watch[^"]+)"/i);
            var trailerUrl = trailerM ? trailerM[1] : null;

            var malM = html.match(/myanimelist\.net\/anime\/(\d+)/);
            var anilistM = html.match(/anilist\.co\/anime\/(\d+)/);
            var syncData = {};
            if (malM) syncData.mal = malM[1];
            if (anilistM) syncData.anilist = anilistM[1];

            var epRes = parseJSON(await http_get(BASE + '/api/frontend/anime/' + siteId + '/episodes', API_HDR));
            var epList = (epRes && epRes.episodes) || [];
            if (!epList.length) return cb({ success: false, error: 'No episodes found.' });

            var aniZip = null;
            try {
                var zipUrl = anilistM ? 'https://api.ani.zip/mappings?anilist_id=' + anilistM[1]
                           : malM     ? 'https://api.ani.zip/mappings?mal_id='     + malM[1]
                           : null;
                if (zipUrl) {
                    var zipRes = parseJSON(await http_get(zipUrl, { 'User-Agent': UA, Accept: 'application/json' }));
                    if (zipRes && zipRes.episodes) aniZip = zipRes;
                }
            } catch (_) {}

            var firstEpId = epList[0] && epList[0].id;
            var hasSub = true, hasDub = false;
            if (firstEpId) {
                try {
                    var langRes = parseJSON(await http_get(
                        BASE + '/api/frontend/episode/' + firstEpId + '/languages',
                        Object.assign({}, API_HDR, { Referer: BASE + '/anime/' + siteId })
                    ));
                    var langs = (langRes && langRes.languages) || [];
                    hasSub = !langs.length || langs.some(function (l) { return classifyLanguage(l) === 'sub'; });
                    hasDub = langs.some(function (l) { return classifyLanguage(l) === 'dub'; });
                } catch (_) {}
            }

            var episodes = [];
            if (hasDub) {
                episodes = episodes.concat(parseEpisodes(epList, url, aniZip, 'sub', 'sub'));
                episodes = episodes.concat(parseEpisodes(epList, url, aniZip, 'dub', 'dub'));
            } else {
                episodes = parseEpisodes(epList, url, aniZip, 'sub');
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title:      title,
                    url:        url,
                    posterUrl:  poster,
                    type:       isMovie ? 'movie' : 'anime',
                    description: desc,
                    year:       year,
                    score:      score,
                    status:     mappedStatus,
                    tags:       tags,
                    trailers:   trailerUrl ? [new Trailer({ url: trailerUrl })] : [],
                    syncData:   Object.keys(syncData).length ? syncData : undefined,
                    episodes:   episodes
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────

    async function loadStreams(url, cb) {
        try {
            var typeMatch = url.match(/[?&]type=(sub|dub)/i);
            var typeFilter = typeMatch ? typeMatch[1].toLowerCase() : null;

            var cleanUrl = url.replace(/[?&]type=(sub|dub)/i, '').replace(/\?$/, '');
            var parts = cleanUrl.split('/');
            var episodeNum = parts.pop() || '1';
            var animeUrl = parts.join('/');

            var siteId = extractSiteId(animeUrl);
            if (!siteId) return cb({ success: false, error: 'Could not extract siteId from URL.' });

            var epRes = parseJSON(await http_get(BASE + '/api/frontend/anime/' + siteId + '/episodes', API_HDR));
            var epList = (epRes && epRes.episodes) || [];

            var targetEp = null;
            for (var i = 0; i < epList.length; i++) {
                if (String(epList[i].number) === episodeNum) {
                    targetEp = epList[i];
                    break;
                }
            }
            if (!targetEp) return cb({ success: false, error: 'Episode not found.' });

            var langRes = parseJSON(await http_get(
                BASE + '/api/frontend/episode/' + targetEp.id + '/languages',
                Object.assign({}, API_HDR, { Referer: BASE + '/anime/' + siteId })
            ));
            var langs = (langRes && langRes.languages) || [];

            if (typeFilter) {
                langs = langs.filter(function (l) { return classifyLanguage(l) === typeFilter; });
            }

            if (!langs.length) return cb({ success: false, error: 'No streams available for this episode.' });

            var embedReqs = langs.filter(function (l) { return !!l.embed_url; }).map(function (l) {
                return { url: l.embed_url, headers: Object.assign({}, HTML_HDR, { Referer: BASE + '/' }), _lang: l };
            });
            var embedResps = await httpParallelGet(embedReqs);

            var m3u8Batch = [];
            embedResps.forEach(function (resp, i) {
                var langItem = embedReqs[i]._lang;
                var m3u8Url = extractM3u8(resp.body);
                if (!m3u8Url) return;
                var langType = classifyLanguage(langItem);
                var label = langType === 'dub' ? 'Dub' : langType === 'sub' ? 'Sub' : (langItem.name || 'Unknown');
                m3u8Batch.push({ url: m3u8Url, source: 'AniDB - ' + label });
            });

            if (!m3u8Batch.length) return cb({ success: false, error: 'No streams found.' });

            var m3u8Resps = await httpParallelGet(m3u8Batch.map(function (item) {
                return { url: item.url, headers: { Referer: BASE + '/' } };
            }));

            var streams = [];
            m3u8Batch.forEach(function (item, i) {
                var body = m3u8Resps[i] && m3u8Resps[i].body;
                var variants = body ? parseHlsVariants(body, item.url) : null;

                if (variants && variants.length > 1) {
                    variants.forEach(function (v) {
                        streams.push(new StreamResult({
                            url:     v.url,
                            quality: v.label,
                            source:  item.source + ' | ' + v.label,
                            headers: { Referer: BASE + '/' }
                        }));
                    });
                } else {
                    var quality = variants && variants[0] ? variants[0].label : 'Auto';
                    streams.push(new StreamResult({
                        url:     item.url,
                        quality: quality,
                        source:  item.source,
                        headers: { Referer: BASE + '/' }
                    }));
                }
            });

            if (!streams.length) return cb({ success: false, error: 'No streams found.' });
            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();
