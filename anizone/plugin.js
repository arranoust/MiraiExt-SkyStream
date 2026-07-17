(function () {

    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    var HEADERS = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    var HOME_CATEGORIES = [
        { name: 'TV Series', type: '2' },
        { name: 'Movies',    type: '4' },
        { name: 'OVA',       type: '3' },
        { name: 'Web',       type: '6' }
    ];

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        if (res.body) return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        return String(res);
    }

    async function parseHtml(html, selector, attrType) {
        try {
            var raw = await parse_html(html, selector, attrType);
            if (!Array.isArray(raw)) return [];
            return raw.map(function (item) {
                if (!item) return '';
                if (typeof item === 'string') return item;
                if (attrType === 'text') return item.text || '';
                return item.attr || item[attrType] || '';
            });
        } catch (_) { return []; }
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
        var variants = [];
        var lines = content.split('\n');
        var inf = null;
        var hasStreamInf = false;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
                hasStreamInf = true;
                var resM = line.match(/RESOLUTION=(\d+)x(\d+)/);
                var bwM  = line.match(/[^-]BANDWIDTH=(\d+)\b/);
                inf = {
                    height:    resM ? parseInt(resM[2], 10) : 0,
                    bandwidth: bwM  ? parseInt(bwM[1], 10)  : 0
                };
            } else if (line.indexOf('#') === 0 || line.length === 0) {
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

    // ─── Title parsing ────────────────────────────────────────────────────────
    function parseAnmTitles(raw) {
        var s = raw.replace(/\\u0022/g, '"');
        try { return JSON.parse(s); } catch (_) {}
        try { return JSON.parse(s.replace(/:""([^"]*)""/g, ':"$1"')); } catch (_) {}
        return null;
    }

    function decodeTitle(str) {
        if (!str) return '';
        return str
            .replace(/\\u([0-9a-fA-F]{4})/g, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
            .replace(/\\\//g, '/').replace(/\\'/g, "'").replace(/\\"/g, '"')
            .replace(/^"+|"+$/g, '').trim();
    }

    function pickTitle(titles) {
        if (!titles || typeof titles !== 'object') return '';
        var t = titles['1'] || titles['2'] || titles['5'] || titles['10'];
        if (!t) { var keys = Object.keys(titles); for (var i = 0; i < keys.length; i++) { if (titles[keys[i]]) { t = titles[keys[i]]; break; } } }
        return decodeTitle(t);
    }

    function extractTitle(block) {
        var m = block.match(/anmTitles:\s*JSON\.parse\('([\s\S]+?)'\)/);
        if (m) { var p = parseAnmTitles(m[1]); if (p) return pickTitle(p); }
        var fb = block.match(/window\.getTitle\s*\([^,)]+,\s*'([^']+)'\s*\)/);
        if (fb) return decodeTitle(fb[1].replace(/&quot;/g, '"'));
        return '';
    }

    // ─── Livewire session ─────────────────────────────────────────────────────
    async function initLivewire() {
        var res  = await http_get(manifest.baseUrl + '/anime', HEADERS);
        var html = getBody(res);

        var tokenMatch = html.match(/<script[^>]+data-csrf="([^"]+)"/);
        if (!tokenMatch) return null;

        var cookie = '';
        var raw = res.headers && (res.headers['set-cookie'] || res.headers['Set-Cookie']);
        if (Array.isArray(raw)) cookie = raw.map(function (c) { return c.split(';')[0]; }).join('; ');
        else if (typeof raw === 'string') cookie = raw.split(';')[0];

        var snapshots = [];
        var re = /wire:snapshot="([^"]+)"/g;
        var m;
        while ((m = re.exec(html)) !== null) {
            try {
                var snap = m[1].replace(/&quot;/g, '"');
                var parsed = JSON.parse(snap);
                if (parsed?.memo?.name) snapshots.push({ name: parsed.memo.name, snap });
            } catch (_) {}
        }

        var target = snapshots.find(function (s) { return s.name === 'pages.anime-index'; })
                  || snapshots.find(function (s) { return /anime.index|anime-index/i.test(s.name); })
                  || snapshots[0];

        if (!target) return null;
        return { snapshot: target.snap, token: tokenMatch[1], cookie };
    }

    async function livewireUpdate(wire, updates, calls) {
        var payload = JSON.stringify({
            _token:     wire.token,
            components: [{ snapshot: wire.snapshot, updates: updates, calls: calls || [] }]
        });
        var headers = {
            'User-Agent':   UA,
            'Content-Type': 'application/json',
            'Accept':       'application/json, text/plain, */*',
            'X-Livewire':   'true',
            'Referer':      manifest.baseUrl + '/anime',
            'Origin':       manifest.baseUrl
        };
        if (wire.cookie) headers['Cookie'] = wire.cookie;

        var res  = getBody(await http_post(manifest.baseUrl + '/livewire/update', headers, payload));
        var json = JSON.parse(res);
        var comp = json.components[0];
        wire.snapshot = comp.snapshot;
        var newCookie = json.components[0]?.effects?.xdata?.cookie;
        if (newCookie) wire.cookie = newCookie;
        return comp.effects.html;
    }

    // ─── Parsers ──────────────────────────────────────────────────────────────
    function parseAnimeCards(html) {
        var items = [];
        var parts = html.split(/x-data="\{\s*\n?\s*anmTitles:/);
        for (var i = 1; i < parts.length; i++) {
            var block = parts[i];
            var title = extractTitle('anmTitles:' + block);
            if (!title) continue;
            var hrefM = block.match(/href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+)"/i);
            if (!hrefM || /\/anime\/[a-z0-9]+\/\d+/i.test(hrefM[1])) continue;
            var imgM = block.match(/src="(https?:\/\/anizone\.to\/images\/anime\/[^"]+)"/i);
            items.push(new MultimediaItem({
                title:     title,
                url:       hrefM[1],
                posterUrl: imgM ? imgM[1] : '',
                type:      'anime'
            }));
        }
        return items;
    }

    function parseEpisodeList(html, poster) {
        var eps   = [];
        var parts = html.split(/<li\s+x-data="/i).slice(1);
        for (var i = 0; i < parts.length; i++) {
            var block = parts[i];
            var epM   = block.match(/href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+\/(\d+))"/i);
            if (!epM) continue;
            var epNum  = parseInt(epM[2], 10);
            var thumbM = block.match(/\bsrc="(https?:\/\/[^"]+\/snapshot\.webp)"/i) || block.match(/\bsrc="(https?:\/\/[^"]+\.webp)"/i);
            var h3M    = block.match(/<h3[^>]*>\s*([^<]+?)\s*<\/h3>/i);
            var dateM  = block.match(/(\d{4}-\d{2}-\d{2})/);
            var name   = (h3M && h3M[1].trim() !== 'Untitled') ? h3M[1].trim() : 'Episode ' + epNum;
            eps.push(new Episode({
                name:      name,
                url:       epM[1],
                season:    1,
                episode:   epNum,
                dubStatus: 'subbed',
                posterUrl: thumbM ? thumbM[1] : poster,
                airDate:   dateM ? dateM[1] : ''
            }));
        }
        return eps;
    }

    async function fetchAllEpisodes(url, firstHtml, poster) {
        var episodes = parseEpisodeList(firstHtml, poster);
        var totalM   = firstHtml.match(/of\s*<[^>]+>\s*([\d,]+)\s*<\/[^>]+>\s*results/i);
        var total    = totalM ? parseInt(totalM[1].replace(/,/g, ''), 10) : 0;
        var perPage  = episodes.length || 36;
        var pages    = total > 0 ? Math.ceil(total / perPage) : 1;

        if (pages > 1) {
            var pageUrls = [];
            for (var p = 2; p <= pages; p++) pageUrls.push(url + '?page=' + p);
            var more = await Promise.all(pageUrls.map(async function (u) {
                try { return parseEpisodeList(getBody(await http_get(u, HEADERS)), poster); }
                catch (_) { return []; }
            }));
            more.forEach(function (eps) { episodes = episodes.concat(eps); });
        }

        episodes.sort(function (a, b) { return a.episode - b.episode; });
        return episodes;
    }

    // ─── AniList ──────────────────────────────────────────────────────────────
    async function getAniListData(title) {
        if (!title) return null;
        try {
            var res   = await http_post('https://graphql.anilist.co',
                { 'Content-Type': 'application/json', Accept: 'application/json' },
                JSON.stringify({ query: 'query($s:String){Media(search:$s,type:ANIME){id idMal}}', variables: { s: title } })
            );
            var data  = typeof res?.body === 'string' ? JSON.parse(res.body) : res?.body;
            var media = data?.data?.Media;
            if (!media) return null;
            return {
                anilistId: media.id    ? String(media.id)    : null,
                idMal:     media.idMal ? String(media.idMal) : null
            };
        } catch (_) { return null; }
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var wire = await initLivewire();
            if (!wire) return cb({ success: false, error: 'Failed to init Livewire.' });

            await livewireUpdate(wire, { sort: 'release-desc' }, []);

            var result = {};
            for (var i = 0; i < HOME_CATEGORIES.length; i++) {
                var cat = HOME_CATEGORIES[i];
                try {
                    var html  = await livewireUpdate(wire, { type: cat.type },
                        [{ path: '', method: 'loadMore', params: [] }]);
                    var items = parseAnimeCards(html);
                    if (items.length) result[cat.name] = items;
                } catch (_) {}
            }

            if (!Object.keys(result).length) return cb({ success: false, error: 'No content found.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var wire = await initLivewire();
            if (!wire) return cb({ success: false, error: 'Failed to init Livewire.' });
            var html = await livewireUpdate(wire, { search: query }, []);
            cb({ success: true, data: parseAnimeCards(html) });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            url = url.replace(/\/anime\/([a-z0-9]+)\/\d+$/i, '/anime/$1');
            var html = getBody(await http_get(url, HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load anime detail HTML.' });

            var animeTitle = extractTitle(html);
            if (!animeTitle) {
                var ogTitle = (await parseHtml(html, 'meta[property="og:title"]', 'content'))[0];
                if (ogTitle) animeTitle = ogTitle.replace(/\s*[\|\-–—]\s*AniZone.*$/i, '').trim();
            }
            if (!animeTitle) {
                var pageTitle = (await parseHtml(html, 'title', 'text'))[0];
                if (pageTitle) animeTitle = pageTitle.replace(/\s*[\|\-–—]\s*AniZone.*$/i, '').trim();
            }
            if (!animeTitle) animeTitle = 'No Title';

            var poster    = (await parseHtml(html, 'img[src*="/images/anime/"]', 'src'))[0] || '';
            var synopsis  = ((await parseHtml(html, '.text-slate-100.text-center div', 'text'))[0] || '').trim() || 'No description available.';
            var isOngoing = /ongoing/i.test(html);

            var [aniListData, episodes] = await Promise.all([
                getAniListData(animeTitle),
                fetchAllEpisodes(url, html, poster)
            ]);

            var syncData = {};
            if (aniListData?.idMal)     syncData.mal     = aniListData.idMal;
            if (aniListData?.anilistId) syncData.anilist = aniListData.anilistId;

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       animeTitle,
                    url,
                    posterUrl:   poster,
                    type:        'anime',
                    status:      isOngoing ? 'ongoing' : 'completed',
                    description: synopsis,
                    episodes,
                    syncData:    Object.keys(syncData).length ? syncData : undefined
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var html = getBody(await http_get(url, HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load episode HTML.' });

            var m3u8Url = (await parseHtml(html, 'media-player[src]', 'src'))[0];
            if (!m3u8Url) return cb({ success: false, error: 'Stream not found.' });

            var subSrcs   = await parseHtml(html, 'track[kind="subtitles"]', 'src');
            var subLabels = await parseHtml(html, 'track[kind="subtitles"]', 'label');
            var subLangs  = await parseHtml(html, 'track[kind="subtitles"]', 'srclang');

            var subtitles = subSrcs.reduce(function (acc, src, i) {
                if (src) acc.push({ url: src, label: subLabels[i] || ('Sub ' + i), lang: subLangs[i] || 'und' });
                return acc;
            }, []);

            var m3u8Body = '';
            try { m3u8Body = getBody(await http_get(m3u8Url, { ...HEADERS, Referer: manifest.baseUrl + '/' })); } catch (_) {}

            var variants = m3u8Body ? parseHlsVariants(m3u8Body, m3u8Url) : null;

            if (variants && variants.length > 1) {
                var streams = variants.map(function (v) {
                    return new StreamResult({
                        url:       v.url,
                        quality:   v.label,
                        source:    'AniZone | ' + v.label,
                        headers:   { Referer: manifest.baseUrl + '/' },
                        subtitles: subtitles.length ? subtitles : undefined
                    });
                });
                return cb({ success: true, data: streams });
            }

            cb({
                success: true,
                data: [new StreamResult({
                    url:       m3u8Url,
                    quality:   variants && variants[0] ? variants[0].label : 'Auto',
                    source:    'AniZone',
                    headers:   { Referer: manifest.baseUrl + '/' },
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
