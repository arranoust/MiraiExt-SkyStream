(function () {

    // ─── Config ───────────────────────────────────────────────────────────────
    // manifest.baseUrl is injected per active domain from plugin.json `domains`.
    // SERIES_URL must be declared in plugin.json as a second domain entry.
    var BASE_URL   = manifest.baseUrl;
    var SERIES_URL = 'https://series.lk21.de'; // kept as fallback; add to domains[] in plugin.json
    var UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    var HTML_HDR   = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    var PLAYER_HDR = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', Referer: 'https://playeriframe.sbs/' };
    var CONCURRENCY = 3; // max parallel requests in getHome

    var HOME_CATEGORIES = [
        { name: 'Film Terpopuler',                url: BASE_URL   + '/populer/page/1'        },
        { name: 'Film Berdasarkan IMDb Rating',   url: BASE_URL   + '/rating/page/1'         },
        { name: 'Film Dengan Komentar Terbanyak', url: BASE_URL   + '/most-commented/page/1' },
        { name: 'Series Terbaru',                 url: SERIES_URL + '/latest-series/page/1'  },
        { name: 'Film Asian Terbaru',             url: SERIES_URL + '/series/asian/page/1'   },
        { name: 'Film Upload Terbaru',            url: BASE_URL   + '/latest/page/1'         }
    ];

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
            return raw.map(function (item) {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (attr === 'text') return item.text || '';
                if (attr === 'html') return item.html || '';
                return item.attr || item[attr] || '';
            });
        } catch (_) { return []; }
    }

    function getOrigin(url) {
        try { var u = new URL(url); return u.protocol + '//' + u.host; }
        catch (_) { return ''; }
    }

    function cleanTitle(raw) {
        return (raw || '')
            .replace(/^nonton\s+/i, '')
            .replace(/\s+sub\s+indo\s+di\s+lk21\s*$/i, '')
            .replace(/\s+di\s+lk21\s*$/i, '')
            .replace(/\s+sub\s+indo\s*$/i, '')
            .trim();
    }

    function extractQuality(url) {
        var m = (url || '').match(/[/_](\d{3,4}p?)\.m3u8/i)
             || (url || '').match(/[/_](2160|1080|720|480|360|240)(?:[^0-9]|$)/i);
        return m ? m[1].replace(/p?$/, '') + 'p' : 'Auto';
    }

    function unpackIfNeeded(html) {
        if (!html.includes('eval(function(p,a,c,k,e')) return html;
        try { return getAndUnpack(html); } catch (_) { return html; }
    }

    function extractM3u8(src) {
        var m = src.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,400}?)["']/i)
             || src.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
             || src.match(/source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
        return m ? m[1] : null;
    }

    // Runs promises with max `limit` in parallel at a time
    async function parallelLimit(tasks, limit) {
        var results = [];
        for (var i = 0; i < tasks.length; i += limit) {
            var chunk = await Promise.all(tasks.slice(i, i + limit).map(function (t) { return t(); }));
            results = results.concat(chunk);
        }
        return results;
    }

    // ─── Resolvers ────────────────────────────────────────────────────────────

    // P2P: playeriframe.sbs/iframe/p2p/{token} → cloud.hownetwork.xyz
    async function resolveP2P(wrapperUrl) {
        try {
            var wrapHtml  = getBody(await http_get(wrapperUrl, { ...HTML_HDR, Referer: BASE_URL + '/' }));
            var iframeSrc = (wrapHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i) || [])[1];
            if (!iframeSrc) return null;

            var token = (iframeSrc.match(/[?&]id=([^&]+)/) || [])[1];
            if (!token) return null;

            var json = JSON.parse(getBody(await http_post(
                'https://cloud.hownetwork.xyz/api2.php?id=' + encodeURIComponent(token),
                { 'User-Agent': UA, Referer: 'https://cloud.hownetwork.xyz/', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://cloud.hownetwork.xyz' },
                'r=&d=https%3A%2F%2Fcloud.hownetwork.xyz'
            )));

            var file = json.file || json.url;
            if (!file) return null;
            var q = extractQuality(file);
            return new StreamResult({ url: file, quality: q, source: 'P2P | ' + q, headers: { Referer: 'https://cloud.hownetwork.xyz/' } });
        } catch (_) { return null; }
    }

    // TurboVIP: playeriframe.sbs/iframe/turbovip/{id}
    async function resolveTurboVip(wrapperUrl) {
        try {
            var wrapHtml  = getBody(await http_get(wrapperUrl, { ...HTML_HDR, Referer: BASE_URL + '/' }));
            var iframeSrc = (wrapHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i) || [])[1];
            if (!iframeSrc) return null;

            var src  = unpackIfNeeded(getBody(await http_get(iframeSrc, PLAYER_HDR)));
            var m3u8 = extractM3u8(src);
            if (!m3u8) return null;

            var q = extractQuality(m3u8);
            return new StreamResult({ url: m3u8, quality: q, source: 'TurboVIP | ' + q, headers: { Referer: getOrigin(iframeSrc) + '/', Origin: getOrigin(iframeSrc) } });
        } catch (_) { return null; }
    }

    // Cast: playeriframe.sbs/iframe/cast/{id}
    async function resolveCast(wrapperUrl) {
        try {
            var wrapHtml  = getBody(await http_get(wrapperUrl, { ...HTML_HDR, Referer: BASE_URL + '/' }));
            var iframeSrc = (wrapHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i) || [])[1];
            if (!iframeSrc) return null;

            var src  = unpackIfNeeded(getBody(await http_get(iframeSrc, PLAYER_HDR)));
            var m3u8 = extractM3u8(src);
            if (!m3u8) return null;

            var q = extractQuality(m3u8);
            return new StreamResult({ url: m3u8, quality: q, source: 'Cast | ' + q, headers: { Referer: getOrigin(iframeSrc) + '/' } });
        } catch (_) { return null; }
    }

    async function resolveEmbed(embedUrl) {
        if (!embedUrl) return null;
        var h = embedUrl.toLowerCase();
        if (h.includes('/iframe/p2p/')     || h.includes('cloud.hownetwork')) return resolveP2P(embedUrl);
        if (h.includes('/iframe/turbovip/')|| h.includes('emturbovid') || h.includes('turbovidhls')) return resolveTurboVip(embedUrl);
        if (h.includes('/iframe/cast/')    || h.includes('sb1254w9megshle')) return resolveCast(embedUrl);
        return null; // Hydrax requires CF Turnstile — unsupported
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function parseArticles(html, pageUrl) {
        var base   = getOrigin(pageUrl);
        var hrefs  = await parseHtml(html, 'article figure a',   'href');
        var imgs   = await parseHtml(html, 'article figure img', 'src');
        var titles = await parseHtml(html, 'article figure h3',  'text');
        return hrefs.map(function (href, i) {
            var title = cleanTitle((titles[i] || '').trim());
            if (!href || !title) return null;
            return new MultimediaItem({
                title:     title,
                url:       href.startsWith('http') ? href : base + href,
                posterUrl: imgs[i] || '',
                type:      'series'
            });
        }).filter(Boolean);
    }

    async function getHome(cb) {
        try {
            var tasks = HOME_CATEGORIES.map(function (cat) {
                return async function () {
                    try {
                        var html  = getBody(await http_get(cat.url, HTML_HDR));
                        var items = await parseArticles(html, cat.url);
                        return { name: cat.name, items: items };
                    } catch (_) { return { name: cat.name, items: [] }; }
                };
            });

            var results = await parallelLimit(tasks, CONCURRENCY);
            var data    = {};
            results.forEach(function (r) { if (r.items.length) data[r.name] = r.items; });

            if (!Object.keys(data).length) return cb({ success: false, error: 'Failed to load homepage.' });
            cb({ success: true, data: data });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function getSearchDomain() {
        try {
            var html  = getBody(await http_get(BASE_URL, HTML_HDR));
            var match = html.match(/["'](https?:\/\/tv\d+\.lk21official\.cc)["']/i);
            if (match) return match[1];
        } catch (_) {}
        return 'https://tv10.lk21official.cc';
    }

    async function search(query, cb) {
        try {
            var searchDomain = await getSearchDomain();
            var res = await http_get(
                'https://gudangvape.com/search.php?s=' + encodeURIComponent(query) + '&page=1',
                { 'User-Agent': UA, Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', Origin: searchDomain, Referer: searchDomain + '/' }
            );
            var body = getBody(res);
            var arr  = JSON.parse(body).data || JSON.parse(body).items || [];
            var items = arr.map(function (item) {
                var isSeries = item.type === 'series';
                return new MultimediaItem({
                    title:     cleanTitle((item.title || '').replace(/\(\d{4}\)$/, '').trim()),
                    url:       isSeries ? (SERIES_URL + '/' + item.slug) : (BASE_URL + '/' + item.slug),
                    posterUrl: item.poster ? ('https://poster.showcdnx.com/wp-content/uploads/' + item.poster) : '',
                    type:      isSeries ? 'series' : 'movie'
                });
            }).filter(function (i) { return i.title; });
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var fixedUrl = url;
            if (!url.startsWith(SERIES_URL)) {
                var res0 = await http_get(url, { ...HTML_HDR, 'Allow-Redirects': 'false' });
                var loc  = res0.headers?.location || res0.headers?.Location;
                if (loc) fixedUrl = loc;
            }

            var html   = getBody(await http_get(fixedUrl, HTML_HDR));
            var base   = getOrigin(fixedUrl);
            var title  = cleanTitle(((await parseHtml(html, 'div.movie-info h1', 'text'))[0] || '').trim()) || 'Unknown';
            var poster = (await parseHtml(html, 'meta[property="og:image"]', 'content'))[0] || '';
            var desc   = ((await parseHtml(html, 'div.meta-info', 'text'))[0] || '').trim();

            var seasonScripts = await parseHtml(html, 'script#season-data', 'html');
            var isSeries      = seasonScripts.length > 0 && seasonScripts[0];

            if (isSeries) {
                var episodes = [];
                try {
                    var root = JSON.parse(seasonScripts[0]);
                    Object.keys(root).forEach(function (k) {
                        root[k].forEach(function (ep, i) {
                            var epNum = ep.episode_no || (i + 1);
                            episodes.push(new Episode({
                                name:      'Episode ' + epNum,
                                url:       base + '/' + ep.slug,
                                season:    ep.s || 1,
                                episode:   epNum,
                                posterUrl: ep.thumbnail || ep.poster || ep.image || poster
                            }));
                        });
                    });
                } catch (_) {}
                cb({ success: true, data: new MultimediaItem({ title, url, posterUrl: poster, type: 'series', description: desc, episodes }) });
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
            var html        = getBody(await http_get(url, HTML_HDR));
            var playerHrefs = await parseHtml(html, 'ul#player-list > li a', 'href');
            if (!playerHrefs.length) return cb({ success: false, error: 'No players found.' });

            var streams = [];
            await Promise.all(playerHrefs.map(async function (href) {
                if (!href) return;
                try {
                    var fullHref = href.startsWith('http') ? href : (getOrigin(url) + href);
                    var resolved = await resolveEmbed(fullHref);
                    if (resolved) streams.push(resolved);
                } catch (_) {}
            }));

            if (!streams.length) return cb({ success: false, error: 'No streams found.' });
            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams  = loadStreams;

})();