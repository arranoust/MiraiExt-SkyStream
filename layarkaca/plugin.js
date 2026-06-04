(function () {

    // ─── Constants ────────────────────────────────────────────────────────────
    var BASE_URL   = manifest.baseUrl;
    var SERIES_URL = 'https://series.lk21.de';
    var POSTER_CDN = 'https://poster.showcdnx.com/wp-content/uploads/';
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

    // P2P — POST to cloud.hownetwork.xyz/api2.php
    async function resolveHownetwork(embedUrl) {
        try {
            var id  = embedUrl.split('id=')[1] || embedUrl.split('/').pop() || '';
            // playeriframe.sbs/iframe/p2p/{token} → extract token
            var tokenMatch = embedUrl.match(/\/iframe\/p2p\/([^/?]+)/);
            var token = tokenMatch ? tokenMatch[1] : id;

            var apiUrl = 'https://cloud.hownetwork.xyz/api2.php?id=' + encodeURIComponent(token);
            var res = await http_post(
                apiUrl,
                {
                    'User-Agent':       UA,
                    'Referer':          embedUrl,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type':     'application/x-www-form-urlencoded',
                    'Origin':           'https://playeriframe.sbs'
                },
                'r=&d=https%3A%2F%2Fplayeriframe.sbs'
            );
            var json = JSON.parse(getBody(res));
            var file = json.file || json.url || null;
            if (!file) return null;
            return new StreamResult({
                url:     file,
                quality: 'Multi Quality',
                source:  'P2P',
                headers: { 'Referer': 'https://playeriframe.sbs/' }
            });
        } catch (_) { return null; }
    }

    // TurboVIP — playeriframe.sbs wraps emturbovid.com/t/{id}, scrape iframe src then extract m3u8
    async function resolveTurboVip(embedUrl) {
        try {
            // embedUrl = https://playeriframe.sbs/iframe/turbovip/{id}
            var wrapHtml = getBody(await http_get(embedUrl, { ...HTML_HDR, 'Referer': BASE_URL + '/' }));
            var iframeSrc = wrapHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i)?.[1];
            if (!iframeSrc) return null;

            // iframeSrc = https://emturbovid.com/t/{id} or https://turbovidhls.com/...
            var innerHtml = getBody(await http_get(iframeSrc, { ...HTML_HDR, 'Referer': 'https://playeriframe.sbs/' }));
            var src = innerHtml;
            if (innerHtml.includes('eval(function(p,a,c,k,e')) {
                try { src = getAndUnpack(innerHtml); } catch (_) {}
            }

            var m = src.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,300}?)["']/i)
                 || src.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
                 || src.match(/source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
            if (!m) return null;

            return new StreamResult({
                url:     m[1],
                quality: 'Multi Quality',
                source:  'TurboVIP',
                headers: { 'Referer': getBaseUrl(iframeSrc) + '/', 'Origin': getBaseUrl(iframeSrc) }
            });
        } catch (_) { return null; }
    }

    // Cast — playeriframe.sbs wraps sb1254w9megshle.org/e/{id}, scrape m3u8
    async function resolveCast(embedUrl) {
        try {
            // embedUrl = https://playeriframe.sbs/iframe/cast/{id}
            var wrapHtml = getBody(await http_get(embedUrl, { ...HTML_HDR, 'Referer': BASE_URL + '/' }));
            var iframeSrc = wrapHtml.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i)?.[1];
            if (!iframeSrc) return null;

            // iframeSrc = https://sb1254w9megshle.org/e/{id}
            var innerHtml = getBody(await http_get(iframeSrc, { ...HTML_HDR, 'Referer': 'https://playeriframe.sbs/' }));
            var src = innerHtml;
            if (innerHtml.includes('eval(function(p,a,c,k,e')) {
                try { src = getAndUnpack(innerHtml); } catch (_) {}
            }

            var m = src.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,400}?)["']/i)
                 || src.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
                 || src.match(/source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
            if (!m) return null;

            return new StreamResult({
                url:     m[1],
                quality: 'Multi Quality',
                source:  'Cast',
                headers: { 'Referer': getBaseUrl(iframeSrc) + '/' }
            });
        } catch (_) { return null; }
    }

    // Filesim — generic packed JS resolver (kept as fallback)
    async function resolveFilesim(embedUrl) {
        try {
            var html = getBody(await http_get(embedUrl, { ...HTML_HDR, 'Referer': getBaseUrl(embedUrl) + '/' }));
            var src  = html;
            if (html.includes('eval(function(p,a,c,k,e')) {
                try { src = getAndUnpack(html); } catch (_) {}
            }

            var arr = src.match(/sources\s*:\s*\[([^\]]+)\]/i);
            if (arr) {
                var results     = [];
                var fileMatches = arr[1].matchAll(/file\s*:\s*["']([^"']+)["'][^}]*(?:label\s*:\s*["']([^"']*)["'])?/gi);
                for (var m of fileMatches) {
                    if (!m[1]) continue;
                    results.push(new StreamResult({
                        url:     m[1],
                        quality: m[2] || 'Auto',
                        source:  'Filesim',
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
                    source:  'Filesim',
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
                return [new StreamResult({ url: file, quality: 'Auto', source: 'Vidhide', headers: { 'Referer': embedUrl } })];
            }
            return [new StreamResult({ url: m[1], quality: 'Auto', source: 'Vidhide', headers: { 'Referer': embedUrl } })];
        } catch (_) { return null; }
    }

    // ─── Main embed dispatcher ────────────────────────────────────────────────
    async function resolveEmbed(embedUrl, serverName, referer) {
        if (!embedUrl) return null;
        var host = embedUrl.toLowerCase();

        // Route by data-server name first (most reliable)
        if (serverName === 'p2p' || host.includes('playeriframe.sbs/iframe/p2p')) {
            var r = await resolveHownetwork(embedUrl);
            return r ? [r] : null;
        }
        if (serverName === 'turbovip' || host.includes('playeriframe.sbs/iframe/turbovip') || host.includes('emturbovid') || host.includes('turbovidhls')) {
            var r = await resolveTurboVip(embedUrl);
            return r ? [r] : null;
        }
        if (serverName === 'cast' || host.includes('playeriframe.sbs/iframe/cast') || host.includes('sb1254w9megshle')) {
            var r = await resolveCast(embedUrl);
            return r ? [r] : null;
        }
        // Hydrax uses CF Turnstile + encrypted payload — not resolvable server-side
        if (serverName === 'hydrax' || host.includes('playeriframe.sbs/iframe/hydrax')) {
            return null;
        }

        if (host.includes('hownetwork')) {
            var r = await resolveHownetwork(embedUrl);
            return r ? [r] : null;
        }
        if (host.includes('vidhide') || host.includes('vhide')) {
            return await resolveVidhide(embedUrl);
        }
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
            var res  = await http_get(
                'https://gudangvape.com/search.php?s=' + encodeURIComponent(query) + '&page=1',
                {
                    'User-Agent':       UA,
                    'Accept':           '*/*',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Origin':           searchDomain,
                    'Referer':          searchDomain + '/'
                }
            );
            var body = getBody(res);
            var root = JSON.parse(body);
            var arr  = root.data || root.items || [];

            var items = arr.map(function(item) {
                var type     = item.type === 'series' ? 'series' : 'movie';
                var url      = type === 'series'
                    ? (SERIES_URL + '/' + item.slug)
                    : (BASE_URL   + '/' + item.slug);
                var rawTitle = (item.title || '').replace(/\(\d{4}\)$/, '').trim();
                return new MultimediaItem({
                    title:     cleanTitle(rawTitle),
                    url:       url,
                    posterUrl: item.poster ? (POSTER_CDN + item.poster) : '',
                    type:      type
                });
            }).filter(function(i) { return i.title; });

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
            var html = getBody(await http_get(url, HTML_HDR));

            // Extract player links with server names from data-server attribute
            var playerHtml = await parseHtml(html, 'ul#player-list > li a', 'html');
            var playerHrefs      = await parseHtml(html, 'ul#player-list > li a', 'href');
            var playerDataServer = await parseHtml(html, 'ul#player-list > li a', 'data-server');
            var playerText       = await parseHtml(html, 'ul#player-list > li a', 'text');

            if (!playerHrefs.length)
                return cb({ success: false, error: 'Tidak ada player ditemukan.' });

            var streams = [];

            await Promise.all(playerHrefs.map(async function(playerHref, idx) {
                if (!playerHref) return;
                var serverName = (playerDataServer[idx] || playerText[idx] || '').trim().toLowerCase();

                try {
                    var fullHref = playerHref.startsWith('http') ? playerHref : (getBaseUrl(url) + playerHref);

                    // For playeriframe.sbs servers, resolve directly without fetching the wrapper page again
                    var resolved = await resolveEmbed(fullHref, serverName, url);

                    if (!resolved || !resolved.length) {
                        // Fallback: fetch wrapper page and look for nested iframe
                        var pageHtml = getBody(await http_get(fullHref, { ...HTML_HDR, 'Referer': SERIES_URL + '/' }));
                        var iframes  = await parseHtml(pageHtml, 'div.embed-container iframe', 'src');
                        var iframeSrc = iframes[0];
                        if (iframeSrc) {
                            resolved = await resolveEmbed(iframeSrc, serverName, fullHref);
                        }
                    }

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