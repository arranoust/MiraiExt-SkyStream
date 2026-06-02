(function () {

    // ─── Constants ────────────────────────────────────────────────────────────
    var BASE_URL   = manifest.baseUrl;
    var SERIES_URL = 'https://series.lk21.de';
    var POSTER_CDN = 'https://static-jpg.lk21.party/wp-content/uploads/';
    var UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    var HTML_HDR   = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' };
    var JSON_HDR   = { 'User-Agent': UA, 'Accept': 'application/json' };

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    }

    async function parseHtml(html, selector, attr) {
        try {
            var raw = await parse_html(html, selector, attr);
            if (!Array.isArray(raw)) return [];
            return raw.map(function(item) {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (attr === 'text') return item.text || '';
                if (attr === 'html') return item.html || '';
                return item.attr || item[attr] || '';
            });
        } catch (_) { return []; }
    }

    function getBaseUrl(url) {
        try {
            var u = new URL(url);
            return u.protocol + '//' + u.host;
        } catch (_) { return ''; }
    }

    function cleanTitle(raw) {
        return (raw || '')
            .replace(/^nonton\s+/i, '')
            .replace(/\s+sub\s+indo\s+di\s+lk21\s*$/i, '')
            .replace(/\s+di\s+lk21\s*$/i, '')
            .replace(/\s+sub\s+indo\s*$/i, '')
            .trim();
    }

    // ─── Resolvers ────────────────────────────────────────────────────────────

    async function resolveHownetwork(embedUrl) {
        try {
            var id  = embedUrl.split('id=')[1] || '';
            var res = await http_post(
                getBaseUrl(embedUrl) + '/api.php?id=' + id,
                {
                    'User-Agent':       UA,
                    'Referer':          embedUrl,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type':     'application/x-www-form-urlencoded'
                },
                'r=&d=' + encodeURIComponent(getBaseUrl(embedUrl))
            );
            var json = JSON.parse(getBody(res));
            var file = json.file || null;
            if (!file) return null;
            return new StreamResult({
                url:     file,
                quality: 'Multi Quality',
                headers: { 'Referer': embedUrl }
            });
        } catch (_) { return null; }
    }

    async function resolveFilesim(embedUrl) {
        try {
            var html = getBody(await http_get(embedUrl, { ...HTML_HDR, 'Referer': getBaseUrl(embedUrl) + '/' }));
            var src  = html;
            if (html.includes('eval(function(p,a,c,k,e')) {
                try { src = getAndUnpack(html); } catch (_) {}
            }

            var arr = src.match(/sources\s*:\s*\[([^\]]+)\]/i);
            if (arr) {
                var results      = [];
                var fileMatches  = arr[1].matchAll(/file\s*:\s*["']([^"']+)["'][^}]*(?:label\s*:\s*["']([^"']*)["'])?/gi);
                for (var m of fileMatches) {
                    if (!m[1]) continue;
                    results.push(new StreamResult({
                        url:     m[1],
                        quality: m[2] || 'Auto',
                        headers: { 'Referer': embedUrl }
                    }));
                }
                if (results.length) return results;
            }

            var single = src.match(/file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
                || src.match(/["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
            if (single && single[1]) {
                return [new StreamResult({
                    url:     single[1],
                    quality: 'Auto',
                    headers: { 'Referer': embedUrl }
                })];
            }

            return null;
        } catch (_) { return null; }
    }

    async function resolveVidhide(embedUrl) {
        try {
            var html = getBody(await http_get(embedUrl, { ...HTML_HDR, 'Referer': BASE_URL + '/' }));
            var src  = html;
            if (html.includes('eval(function(p,a,c,k,e')) {
                try { src = getAndUnpack(html); } catch (_) {}
            }
            var m = src.match(/["'](https?:\/\/[^"']+\/api\/server[^"']*)["']/i)
                 || src.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
            if (!m) return null;

            if (m[1].includes('/api/server')) {
                var apiRes  = await http_get(m[1], { ...JSON_HDR, 'Referer': embedUrl });
                var apiJson = JSON.parse(getBody(apiRes));
                var file    = apiJson.url || apiJson.file || apiJson.src;
                if (!file) return null;
                return [new StreamResult({ url: file, quality: 'Auto', headers: { 'Referer': embedUrl } })];
            }

            return [new StreamResult({ url: m[1], quality: 'Auto', headers: { 'Referer': embedUrl } })];
        } catch (_) { return null; }
    }

    async function resolveEmbed(embedUrl, referer) {
        if (!embedUrl) return null;
        var host = embedUrl.toLowerCase();
        if (host.includes('hownetwork'))            return await resolveHownetwork(embedUrl).then(r => r ? [r] : null);
        if (host.includes('vidhide') ||
            host.includes('vhide'))                 return await resolveVidhide(embedUrl);
        return await resolveFilesim(embedUrl);
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        var categories = [
            { name: 'Film Terpopuler',                url: BASE_URL   + '/populer/page/1'        },
            { name: 'Film Berdasarkan IMDb Rating',   url: BASE_URL   + '/rating/page/1'         },
            { name: 'Film Dengan Komentar Terbanyak', url: BASE_URL   + '/most-commented/page/1' },
            { name: 'Series Terbaru',                 url: SERIES_URL + '/latest-series/page/1'  },
            { name: 'Film Asian Terbaru',             url: SERIES_URL + '/series/asian/page/1'   },
            { name: 'Film Upload Terbaru',            url: BASE_URL   + '/latest/page/1'         }
        ];

        try {
            var result = {};
            await Promise.all(categories.map(async function(cat) {
                try {
                    var html  = getBody(await http_get(cat.url, HTML_HDR));
                    var items = await parseArticles(html, cat.url);
                    if (items.length) result[cat.name] = items;
                } catch (_) {}
            }));

            if (!Object.keys(result).length)
                return cb({ success: false, error: 'Gagal memuat homepage.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function parseArticles(html, pageUrl) {
        var base   = getBaseUrl(pageUrl);
        var hrefs  = await parseHtml(html, 'article figure a', 'href');
        var imgs   = await parseHtml(html, 'article figure img', 'src');
        var titles = await parseHtml(html, 'article figure h3', 'text');

        var items = [];
        for (var i = 0; i < hrefs.length; i++) {
            var href  = hrefs[i];
            var title = cleanTitle((titles[i] || '').trim());
            if (!href || !title) continue;
            var fullUrl = href.startsWith('http') ? href : base + href;
            items.push(new MultimediaItem({
                title:     title,
                url:       fullUrl,
                posterUrl: imgs[i] || '',
                type:      'series'
            }));
        }
        return items;
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var html   = getBody(await http_get(BASE_URL + '/?s=' + encodeURIComponent(query), HTML_HDR));
            var hrefs  = await parseHtml(html, 'article figure a', 'href');
            var imgs   = await parseHtml(html, 'article figure img', 'src');
            var titles = await parseHtml(html, 'article figure h3', 'text');

            var items = [];
            for (var i = 0; i < hrefs.length; i++) {
                var href  = hrefs[i];
                var title = cleanTitle((titles[i] || '').trim());
                if (!href || !title) continue;
                var fullUrl = href.startsWith('http') ? href : BASE_URL + href;
                items.push(new MultimediaItem({
                    title:     title,
                    url:       fullUrl,
                    posterUrl: imgs[i] || '',
                    type:      'series'
                }));
            }

            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var fixedUrl = url;
            if (!url.startsWith(SERIES_URL)) {
                var res0 = await http_get(url, { ...HTML_HDR, 'Allow-Redirects': 'false' });
                var loc  = res0.headers && (res0.headers['location'] || res0.headers['Location']);
                if (loc) fixedUrl = loc;
            }

            var html = getBody(await http_get(fixedUrl, HTML_HDR));
            var base = getBaseUrl(fixedUrl);

            var rawTitles = await parseHtml(html, 'div.movie-info h1', 'text');
            var title     = cleanTitle((rawTitles[0] || '').trim()) || 'Unknown';
            var posters   = await parseHtml(html, 'meta[property="og:image"]', 'content');
            var poster    = posters[0] || '';
            var descs     = await parseHtml(html, 'div.meta-info', 'text');
            var desc      = (descs[0] || '').trim();

            var seasonScripts = await parseHtml(html, 'script#season-data', 'html');
            var isSeries      = seasonScripts.length > 0 && seasonScripts[0];

            if (isSeries) {
                var episodes = [];
                try {
                    var root = JSON.parse(seasonScripts[0]);
                    var keys = Object.keys(root);
                    for (var k = 0; k < keys.length; k++) {
                        var epArr = root[keys[k]];
                        for (var i = 0; i < epArr.length; i++) {
                            var ep       = epArr[i];
                            var epNum    = ep.episode_no || (i + 1);
                            var epPoster = ep.thumbnail || ep.poster || ep.image || poster;
                            episodes.push(new Episode({
                                name:      'Episode ' + epNum,
                                url:       base + '/' + ep.slug,
                                season:    ep.s || 1,
                                episode:   epNum,
                                posterUrl: epPoster
                            }));
                        }
                    }
                } catch (_) {}

                cb({ success: true, data: new MultimediaItem({
                    title, url, posterUrl: poster, type: 'series', description: desc, episodes
                })});
            } else {
                cb({ success: true, data: new MultimediaItem({
                    title, url, posterUrl: poster, type: 'movie', description: desc,
                    episodes: [new Episode({ name: title, url, season: 1, episode: 1, posterUrl: poster })]
                })});
            }
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var html    = getBody(await http_get(url, HTML_HDR));
            var players = await parseHtml(html, 'ul#player-list > li a', 'href');

            if (!players.length)
                return cb({ success: false, error: 'Tidak ada player ditemukan.' });

            var streams = [];

            await Promise.all(players.map(async function(playerHref) {
                if (!playerHref) return;
                try {
                    var fullHref = playerHref.startsWith('http') ? playerHref : (getBaseUrl(url) + playerHref);
                    var pageHtml = getBody(await http_get(fullHref, { ...HTML_HDR, 'Referer': SERIES_URL + '/' }));
                    var iframes  = await parseHtml(pageHtml, 'div.embed-container iframe', 'src');
                    var iframeSrc = iframes[0];
                    if (!iframeSrc) return;

                    var resolved = await resolveEmbed(iframeSrc, fullHref);
                    if (resolved && resolved.length) {
                        streams = streams.concat(resolved);
                    }
                } catch (_) {}
            }));

            if (!streams.length)
                return cb({ success: false, error: 'Stream tidak ditemukan.' });
            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();