(function () {

    var BASE = manifest.baseUrl;
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    var HEADERS = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
    };

    var HOME_CATEGORIES = [
        { name: 'Recently Updated', path: '/anime/?status=ongoing&order=update' },
        { name: 'Popular',          path: '/anime/?status=ongoing&order=popular' },
        { name: 'Completed',         path: '/anime/?status=completed&order=update' },
        { name: 'Movies',           path: '/anime/?status=&type=movie' }
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

    function fixUrl(url) {
        if (!url) return '';
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('/')) return BASE + url;
        return url;
    }

    function safeAtob(str) {
        try {
            if (typeof atob === 'function') return atob(str);
            return Buffer.from(str, 'base64').toString('utf8');
        } catch (_) { return null; }
    }

    function parseEpNumber(text) {
        var m = (text || '').match(/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    function extractIframeSrc(html) {
        var m = html.match(/\bsrc=["']([^"']+)["']/i);
        if (m) return m[1];
        var m2 = html.match(/\bsrc=([^\s>]+)/i);
        return m2 ? m2[1] : null;
    }

    function fixProtocol(url) {
        if (!url) return '';
        return url.startsWith('//') ? 'https:' + url : url;
    }

    // ─── Resolvers ────────────────────────────────────────────────────────────

    // Dailymotion: geo.dailymotion.com/video/{id}.json → qualities.auto[0].url
    async function resolveDailymotion(embedUrl, label) {
        try {
            var videoId = (embedUrl.match(/[?&]video=([^&]+)/) || [])[1];
            if (!videoId) videoId = (embedUrl.match(/\/video\/([a-z0-9]+)/i) || [])[1];
            if (!videoId) return null;

            // player-id and publisher-id from embed URL (needed for proper dmTs/dmV1st)
            var playerId  = (embedUrl.match(/player-id=([^&]+)/) || [])[1] || 'x1kcvu';
            var pubId     = (embedUrl.match(/publisher-id=([^&]+)/) || [])[1] || '';
            var dmV1st    = [8,4,4,4,12].map(function(n) {
                return Math.random().toString(16).substring(2, 2+n).padStart(n, '0');
            }).join('-');
            var dmTs      = String(Math.floor(Math.random() * 999999));

            var apiUrl = 'https://geo.dailymotion.com/video/' + videoId + '.json'
                + '?legacy=true'
                + '&embedder='     + encodeURIComponent(BASE + '/')
                + '&player-id='    + encodeURIComponent(playerId)
                + (pubId ? '&publisher-id=' + encodeURIComponent(pubId) : '')
                + '&dmTs='         + dmTs
                + '&dmV1st='       + dmV1st;

            var json = JSON.parse(getBody(await http_get(apiUrl, {
                'User-Agent': UA,
                'Referer':    BASE + '/',
                'Accept':     'application/json'
            })));

            var m3u8 = json.qualities && json.qualities.auto && json.qualities.auto[0] && json.qualities.auto[0].url;
            if (!m3u8) return null;

            var formats = json.stream_formats || {};
            var maxQ    = Object.keys(formats).map(Number).sort(function(a,b){return b-a;})[0];
            var quality = maxQ ? maxQ + 'p' : 'Auto';

            // Extract subtitles from geo API response
            var subtitles = [];
            var subData   = json.subtitles && json.subtitles.data;
            if (subData) {
                Object.keys(subData).forEach(function (lang) {
                    var sub = subData[lang];
                    if (sub && sub.urls && sub.urls[0]) {
                        subtitles.push({
                            url:   sub.urls[0],
                            label: sub.label || lang,
                            lang:  lang
                        });
                    }
                });
            }

            return new StreamResult({
                url:       m3u8,
                quality:   quality,
                source:    (label || 'Dailymotion').trim(),
                headers:   { 'Referer': 'https://geo.dailymotion.com/' },
                subtitles: subtitles.length ? subtitles : undefined
            });
        } catch (_) { return null; }
    }

    // DoodStream: fetch embed page → extract /pass_md5/ path → fetch CDN base URL → append random token
    async function resolveDood(embedUrl, label) {
        try {
            var hostname = new URL(embedUrl).hostname;
            var origin   = 'https://' + hostname;
            var res      = getBody(await http_get(embedUrl, { 'User-Agent': UA, 'Referer': BASE + '/' }));

            // Matches: $.get('/pass_md5/ID/TOKEN', ...) or "/pass_md5/..."
            var md5Match = res.match(/['"]?(\/pass_md5\/[^'")\s]+)['"]?/);
            if (!md5Match) return null;
            var md5Path = md5Match[1];

            // Extract token — last segment of the path
            var token  = md5Path.split('/').pop() || '';
            var md5Url = origin + md5Path;

            var cdnBase = getBody(await http_get(md5Url, {
                'User-Agent': UA,
                'Referer':    embedUrl
            })).trim();

            if (!cdnBase || cdnBase === 'RELOAD' || !cdnBase.startsWith('http')) return null;

            var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            var rand  = '';
            for (var i = 0; i < 10; i++)
                rand += chars.charAt(Math.floor(Math.random() * chars.length));

            return new StreamResult({
                url:     cdnBase + rand + '?token=' + token + '&expiry=' + Date.now(),
                quality: 'Auto',
                source:  (label || 'DoodStream').trim(),
                headers: { 'Referer': origin + '/' }
            });
        } catch (_) { return null; }
    }

    async function resolveEmbed(embedUrl, label) {
        var h = embedUrl.toLowerCase();
        if (h.includes('dailymotion.com'))                      return resolveDailymotion(embedUrl, label);
        if (h.includes('playmogo.com') || h.includes('dood.')) return resolveDood(embedUrl, label);
        return null; // seekplayer (SPA), ok.ru, rumble, odysee, mega → skip
    }

    // ─── getHome ──────────────────────────────────────────────────────────────

    async function parseArticles(html) {
        var titles  = await parseHtml(html, 'div.bsx > a', 'title');
        var hrefs   = await parseHtml(html, 'div.bsx > a', 'href');
        var posters = await parseHtml(html, 'div.bsx > a img', 'src');
        return hrefs.map(function (href, i) {
            if (!href || !titles[i]) return null;
            return new MultimediaItem({
                title:     (titles[i] || 'No Title').trim(),
                url:       fixUrl(href),
                posterUrl: fixUrl(posters[i] || ''),
                type:      'anime'
            });
        }).filter(Boolean);
    }

    async function getHome(cb) {
        try {
            var result = {};
            for (var i = 0; i < HOME_CATEGORIES.length; i++) {
                var cat = HOME_CATEGORIES[i];
                try {
                    var html  = getBody(await http_get(BASE + cat.path + '&page=1', HEADERS));
                    var items = await parseArticles(html);
                    if (items.length) result[cat.name] = items;
                } catch (_) {}
            }
            if (!Object.keys(result).length)
                return cb({ success: false, error: 'Failed to load homepage.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────

    async function search(query, cb) {
        try {
            var html  = getBody(await http_get(BASE + '/page/1/?s=' + encodeURIComponent(query), HEADERS));
            var items = await parseArticles(html);
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────

    async function load(url, cb) {
        try {
            var html    = getBody(await http_get(url, HEADERS));
            var titles  = await parseHtml(html, 'h1.entry-title', 'text');
            var posters = await parseHtml(html, 'div.thumb img', 'src');
            var ogImg   = await parseHtml(html, 'meta[property="og:image"]', 'content');
            var descs   = await parseHtml(html, 'div.entry-content', 'text');
            var typeStr = await parseHtml(html, '.spe', 'text');

            var title   = (titles[0] || '').trim() || 'Unknown';
            var poster  = fixUrl(posters[0] || ogImg[0] || '');
            var desc    = (descs[0] || '').trim();
            var isMovie = (typeStr[0] || '').toLowerCase().includes('movie');

            var epHrefs   = await parseHtml(html, 'div.eplister > ul > li a', 'href');
            var epNums    = await parseHtml(html, 'div.eplister > ul > li div.epl-num', 'text');
            var epPosters = await parseHtml(html, 'div.eplister > ul > li a img', 'src');

            if (isMovie) {
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title, url, posterUrl: poster, type: 'movie', description: desc,
                        episodes: [new Episode({ name: title, url: fixUrl(epHrefs[0] || url), season: 1, episode: 1, posterUrl: poster })]
                    })
                });
            } else {
                var episodes = epHrefs.map(function (href, i) {
                    var epNum = parseEpNumber(epNums[i] || '');
                    return new Episode({
                        name:      epNum ? 'Episode ' + epNum : (epNums[i] || 'Episode ' + (i + 1)),
                        url:       fixUrl(href),
                        season:    1,
                        episode:   epNum || (i + 1),
                        posterUrl: fixUrl(epPosters[i] || poster),
                        dubStatus: 'subbed'
                    });
                }).reverse();

                cb({
                    success: true,
                    data: new MultimediaItem({
                        title, url, posterUrl: poster, type: 'anime', description: desc, episodes
                    })
                });
            }
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────

    async function loadStreams(url, cb) {
        try {
            var html    = getBody(await http_get(url, HEADERS));
            var streams = [];

            // Capture both value (base64) and text label from each <option>
            var options = [];
            var re = /<option[^>]+value=["']([A-Za-z0-9+/=]{20,})["'][^>]*>\s*([^<]+?)\s*<\/option>/gi;
            var m;
            while ((m = re.exec(html)) !== null) {
                options.push({ b64: m[1], label: m[2].trim() });
            }

            if (!options.length)
                return cb({ success: false, error: 'No video options found.' });

            await Promise.all(options.map(async function (opt) {
                try {
                    var decoded  = safeAtob(opt.b64);
                    if (!decoded) return;
                    var embedUrl = fixProtocol(extractIframeSrc(decoded));
                    if (!embedUrl || !embedUrl.startsWith('http')) return;
                    var result = await resolveEmbed(embedUrl, opt.label);
                    if (result) streams.push(result);
                } catch (_) {}
            }));

            if (!streams.length)
                return cb({ success: false, error: 'No playable streams resolved. Available hosts (seekplayer, ok.ru, rumble, odysee, mega) are not supported.' });

            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────

    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();