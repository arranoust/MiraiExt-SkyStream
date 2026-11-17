(function () {

    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    var HEADERS = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    var BASE = String(manifest.baseUrl || 'https://anizone.to').replace(/\/+$/, '');
    var HOSTNAME = (function () {
        try {
            var m = BASE.match(/^https?:\/\/([^\/]+)/i);
            return m ? m[1] : 'anizone.to';
        } catch (_) { return 'anizone.to'; }
    })();
    var DOMAIN_REGEX = HOSTNAME.replace(/\./g, '\\.');

    var HOME_CATEGORIES = [
        { name: 'TV Series', type: '2' },
        { name: 'Movies',    type: '4' },
        { name: 'OVA',       type: '3' },
        { name: 'Web',       type: '6' }
    ];

    // Livewire episode pagination budget. SkyStream allows ~90s per function.
    var EPISODE_TIME_BUDGET_MS = 75000;
    var MAX_EPISODE_PAGES = 60;

    // ─── Errors ───────────────────────────────────────────────────────────────
    function fail(code, message) {
        return { success: false, errorCode: code, message: message, error: message };
    }

    // ─── Generic helpers ──────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        if (res.body) return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
        return String(res);
    }

    function decodeEntities(s) {
        if (!s) return '';
        return String(s)
            .replace(/&quot;/g, '"')
            .replace(/&apos;|&#0?39;|&#x27;/gi, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
            .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); });
    }

    // The site embeds data as JSON inside single-quoted JS literals:
    //   items: JSON.parse('[{\u0022url\u0022: \u0022http:\\\/\\\/anizone.to\/...\u0022}]')
    // One JS-string unescape pass is required before JSON.parse, otherwise the
    // double-escaped slashes end up as literal backslashes in every URL.
    function jsUnescape(s) {
        if (!s) return '';
        return String(s).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, function (_, e) {
            if (e.charAt(0) === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
            if (e.charAt(0) === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
            switch (e) {
                case 'n': return '\n';
                case 'r': return '\r';
                case 't': return '\t';
                case 'b': return '\b';
                case 'f': return '\f';
                case 'v': return '\v';
                default: return e;
            }
        });
    }

    function parseJsonLiteral(raw) {
        if (!raw) return null;
        var s = jsUnescape(decodeEntities(raw));
        try { return JSON.parse(s); } catch (_) {}
        try { return JSON.parse(decodeEntities(raw)); } catch (_) { return null; }
    }

    function parseJsonCall(html, pattern) {
        if (!html) return null;
        var m = html.match(pattern);
        return m ? parseJsonLiteral(m[1]) : null;
    }

    function normalizeUrl(u) {
        if (!u) return '';
        return String(u).replace(/^http:\/\//i, 'https://');
    }

    function stripTags(s) {
        return decodeEntities(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
    }

    function pickTitle(titles, fallback) {
        if (!titles || typeof titles !== 'object') return fallback || '';
        var keys = ['main_title', '5', '1', '2', '8', '10'];
        for (var i = 0; i < keys.length; i++) {
            if (titles[keys[i]]) return String(titles[keys[i]]);
        }
        var all = Object.keys(titles);
        for (var j = 0; j < all.length; j++) {
            if (titles[all[j]]) return String(titles[all[j]]);
        }
        return fallback || '';
    }

    function extractTitle(html) {
        var titles = parseJsonCall(html, /anmTitles:\s*JSON\.parse\('([\s\S]+?)'\)/);
        if (titles) {
            var t = pickTitle(titles);
            if (t) return t;
        }
        var fb = html.match(/window\.getTitle\s*\([^,)]+,\s*'([^']+)'\s*\)/);
        if (fb) return jsUnescape(fb[1]);
        var titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleTag) return stripTags(titleTag[1]).replace(/\s*[\|\-–—]\s*AniZone.*$/i, '').trim();
        return '';
    }

    // ─── Cookie jar (SkyStream has no automatic cookie jar) ───────────────────
    var cookieJar = {};

    function absorbCookies(res) {
        var headers = (res && res.headers) || {};
        var raw = headers['set-cookie'] || headers['Set-Cookie'];
        if (!raw) return;
        var lines = Array.isArray(raw) ? raw : [raw];
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            // Split comma-separated cookies, but not the comma inside Expires=Tue, ...
            var parts = String(lines[i]).split(/,(?=\s*[^;,=\s]+\s*=)/);
            for (var j = 0; j < parts.length; j++) {
                var pair = parts[j].split(';')[0].trim();
                var eq = pair.indexOf('=');
                if (eq <= 0) continue;
                var name = pair.slice(0, eq).trim();
                if (name) cookieJar[name] = pair.slice(eq + 1).trim();
            }
        }
    }

    function cookieHeader() {
        var out = [];
        for (var k in cookieJar) {
            if (Object.prototype.hasOwnProperty.call(cookieJar, k)) out.push(k + '=' + cookieJar[k]);
        }
        return out.join('; ');
    }

    async function httpGet(url, extra) {
        var headers = {};
        for (var k in HEADERS) if (Object.prototype.hasOwnProperty.call(HEADERS, k)) headers[k] = HEADERS[k];
        if (extra) for (var e in extra) if (Object.prototype.hasOwnProperty.call(extra, e)) headers[e] = extra[e];
        var res = await http_get(url, headers);
        absorbCookies(res);
        return getBody(res);
    }

    async function httpPost(url, headers, body) {
        var res = await http_post(url, headers, body);
        absorbCookies(res);
        return getBody(res);
    }

    // ─── Livewire session ─────────────────────────────────────────────────────
    function wireFromHtml(html, url, componentName) {
        var tokenMatch = html.match(/<script[^>]+data-csrf="([^"]+)"/) ||
                         html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/);
        if (!tokenMatch) return null;

        var re = /wire:snapshot="([^"]+)"/g;
        var m;
        var snapshots = [];
        while ((m = re.exec(html)) !== null) {
            var snap = decodeEntities(m[1]);
            try {
                var parsed = JSON.parse(snap);
                if (parsed && parsed.memo && parsed.memo.name) snapshots.push({ name: parsed.memo.name, snap: snap });
            } catch (_) {}
        }

        var target = null;
        for (var i = 0; i < snapshots.length; i++) {
            if (snapshots[i].name === componentName) { target = snapshots[i]; break; }
        }
        if (!target) {
            for (var j = 0; j < snapshots.length; j++) {
                if (new RegExp(componentName.replace(/\./g, '\\.'), 'i').test(snapshots[j].name)) {
                    target = snapshots[j]; break;
                }
            }
        }
        if (!target) return null;
        return { snapshot: target.snap, token: tokenMatch[1], url: url };
    }

    async function initLivewire(url, componentName) {
        var html = await httpGet(url);
        return wireFromHtml(html, url, componentName);
    }

    async function livewireUpdate(wire, updates, calls) {
        var payload = JSON.stringify({
            _token: wire.token,
            components: [{
                snapshot: wire.snapshot,
                updates: updates || {},
                calls: calls || []
            }]
        });
        var headers = {
            'User-Agent': UA,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'X-Livewire': 'true',
            'X-CSRF-TOKEN': wire.token,
            'Referer': wire.url,
            'Origin': BASE
        };
        var ck = cookieHeader();
        if (ck) headers['Cookie'] = ck;

        var res = await httpPost(BASE + '/livewire/update', headers, payload);
        var text = res;
        var json = null;
        try { json = JSON.parse(text); } catch (_) {}

        if (!json) {
            var statusMatch = String(text).match(/"message"\s*:\s*"([^"]+)"/);
            throw new Error('Livewire returned a non-JSON response' +
                (statusMatch ? ' (' + statusMatch[1] + ')' : ''));
        }
        var comp = json.components && json.components[0];
        if (!comp || !comp.effects) {
            throw new Error('Livewire response has no component effects' +
                (json.message ? ' (' + json.message + ')' : ''));
        }
        if (comp.snapshot) wire.snapshot = comp.snapshot;
        return {
            html: comp.effects.html || '',
            dispatches: comp.effects.dispatches || []
        };
    }

    // ─── Parsers ──────────────────────────────────────────────────────────────
    function parseAnimeCards(html) {
        var list = parseJsonCall(html, /items:\s*JSON\.parse\('([\s\S]+?)'\)/);
        if (!Array.isArray(list)) return [];
        var out = [];
        var seen = {};
        for (var i = 0; i < list.length; i++) {
            var a = list[i];
            if (!a) continue;
            var url = normalizeUrl(a.url);
            if (!url || seen[url]) continue;
            seen[url] = true;
            out.push(new MultimediaItem({
                title: a.main_title || pickTitle(a.title_list),
                url: url,
                posterUrl: normalizeUrl(a.cover) || '',
                type: 'anime',
                year: a.start_year || undefined,
                status: a.is_ongoing ? 'ongoing' : 'completed'
            }));
        }
        return out;
    }

    function parseEpisodes(data, poster) {
        if (!Array.isArray(data)) return [];
        var out = [];
        var seen = {};
        for (var i = 0; i < data.length; i++) {
            var ep = data[i];
            if (!ep) continue;
            var url = normalizeUrl(ep.url);
            if (!url || seen[url]) continue;
            seen[url] = true;
            var num = parseInt(ep.slug, 10);
            if (isNaN(num)) num = i + 1;
            out.push(new Episode({
                name: pickTitle(ep.title_list, 'Episode ' + num),
                url: url,
                season: 1,
                episode: num,
                dubStatus: 'subbed',
                posterUrl: normalizeUrl(ep.snapshot) || poster || '',
                airDate: ep.air_date || '',
                description: ep.summary || ''
            }));
        }
        out.sort(function (a, b) { return (a.episode || 0) - (b.episode || 0); });
        return out;
    }

    function episodeCursor(html) {
        var m = html.match(/nextCursor:\s*'([^']+)'/);
        return m ? m[1] : '';
    }

    function findDispatch(dispatches, name) {
        if (!Array.isArray(dispatches)) return null;
        for (var i = 0; i < dispatches.length; i++) {
            if (dispatches[i] && dispatches[i].name === name) return dispatches[i].params || {};
        }
        return null;
    }

    async function fetchAllEpisodes(html, poster, wire) {
        var episodes = parseEpisodes(parseJsonCall(html, /items:\s*JSON\.parse\('([\s\S]+?)'\)/), poster);
        var cursor = episodeCursor(html);
        var hasMore = /hasMore:\s*true/.test(html);
        var deadline = Date.now() + EPISODE_TIME_BUDGET_MS;
        var pages = 0;

        while (hasMore && cursor && pages < MAX_EPISODE_PAGES && Date.now() < deadline) {
            try {
                var r = await livewireUpdate(wire, {}, [
                    { path: '', method: 'loadPage', params: [cursor] }
                ]);
                var batch = findDispatch(r.dispatches, 'items-loaded');
                if (!batch || !Array.isArray(batch.items)) break;
                episodes = episodes.concat(parseEpisodes(batch.items, poster));
                cursor = batch.nextCursor || '';
                hasMore = !!batch.hasMore && !!cursor;
                pages++;
            } catch (_) { break; }
        }

        // Final dedupe after merging pages.
        var seen = {};
        var unique = [];
        episodes.forEach(function (ep) {
            if (!seen[ep.url]) { seen[ep.url] = true; unique.push(ep); }
        });
        unique.sort(function (a, b) { return (a.episode || 0) - (b.episode || 0); });
        return unique;
    }

    async function getAniListData(title) {
        if (!title) return null;
        try {
            var res = await http_post('https://graphql.anilist.co',
                { 'Content-Type': 'application/json', Accept: 'application/json' },
                JSON.stringify({ query: 'query($s:String){Media(search:$s,type:ANIME){id idMal}}', variables: { s: title } })
            );
            var data = JSON.parse(getBody(res));
            var media = data && data.data && data.data.Media;
            if (!media) return null;
            return {
                anilistId: media.id ? String(media.id) : null,
                idMal: media.idMal ? String(media.idMal) : null
            };
        } catch (_) { return null; }
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var wire = await initLivewire(BASE + '/anime', 'pages.anime-index');
            if (!wire) return cb(fail('INIT_FAILED', 'Gagal memulai sesi Livewire AniZone.'));

            var result = {};
            var trending = await livewireUpdate(wire, { type: '0', sort: 'added-desc' }, []);
            var trendingItems = parseAnimeCards(trending.html);
            if (trendingItems.length) result.Trending = trendingItems;

            for (var i = 0; i < HOME_CATEGORIES.length; i++) {
                var cat = HOME_CATEGORIES[i];
                try {
                    var r = await livewireUpdate(wire, { type: cat.type, sort: 'release-desc' }, []);
                    var items = parseAnimeCards(r.html);
                    if (items.length) result[cat.name] = items;
                } catch (_) {}
            }

            if (!Object.keys(result).length) {
                return cb(fail('NO_CONTENT', 'Tidak ada konten AniZone yang bisa dimuat.'));
            }
            cb({ success: true, data: result });
        } catch (e) {
            cb(fail('LIVEWIRE_ERROR', 'Gagal memuat beranda AniZone: ' + String(e && e.message ? e.message : e)));
        }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            if (!query) return cb({ success: true, data: [] });
            var wire = await initLivewire(BASE + '/anime', 'pages.anime-index');
            if (!wire) return cb(fail('INIT_FAILED', 'Gagal memulai sesi Livewire AniZone.'));
            var r = await livewireUpdate(wire, { search: query }, []);
            cb({ success: true, data: parseAnimeCards(r.html) });
        } catch (e) {
            cb(fail('LIVEWIRE_ERROR', 'Gagal mencari di AniZone: ' + String(e && e.message ? e.message : e)));
        }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            url = normalizeUrl(url).replace(/\/anime\/([a-z0-9]+)\/\d+$/i, '/anime/$1');
            var html = await httpGet(url);
            if (!html) return cb(fail('NOT_FOUND', 'Halaman detail AniZone tidak bisa dimuat.'));

            var animeTitle = extractTitle(html) || 'No Title';
            var poster = normalizeUrl((html.match(/src="(https?:\/\/[^"]*\/images\/anime\/[^"]+)"/i) || [])[1]) || '';

            var synopsis = '';
            var synopsisMatch = html.match(/Synopsis<\/h3>\s*<div[^>]*>([\s\S]*?)<\/div>/i);
            if (synopsisMatch) synopsis = stripTags(synopsisMatch[1]).trim();
            if (!synopsis) synopsis = 'No description available.';

            var isOngoing = /<span[^>]*>\s*Ongoing\s*<\/span>/i.test(html);

            var wire = wireFromHtml(html, url, 'pages.anime-detail');
            var tasks = [getAniListData(animeTitle)];
            if (wire) tasks.push(fetchAllEpisodes(html, poster, wire));
            else tasks.push(Promise.resolve(parseEpisodes(parseJsonCall(html, /items:\s*JSON\.parse\('([\s\S]+?)'\)/), poster)));

            var results = await Promise.all(tasks);
            var aniListData = results[0];
            var episodes = results[1] || [];

            var syncData = {};
            if (aniListData && aniListData.idMal) syncData.mal = aniListData.idMal;
            if (aniListData && aniListData.anilistId) syncData.anilist = aniListData.anilistId;

            cb({
                success: true,
                data: new MultimediaItem({
                    title: animeTitle,
                    url: url,
                    posterUrl: poster,
                    type: 'anime',
                    status: isOngoing ? 'ongoing' : 'completed',
                    description: synopsis,
                    episodes: episodes,
                    syncData: Object.keys(syncData).length ? syncData : undefined
                })
            });
        } catch (e) {
            cb(fail('PARSE_ERROR', 'Gagal memuat detail AniZone: ' + String(e && e.message ? e.message : e)));
        }
    }

    // ─── loadStreams ──────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var html = await httpGet(normalizeUrl(url), { Referer: BASE + '/' });
            if (!html) return cb(fail('NOT_FOUND', 'Halaman episode AniZone tidak bisa dimuat.'));

            var players = [];
            var re = /vidstackPlayer\(JSON\.parse\('([\s\S]+?)'\)\)/g;
            var m;
            while ((m = re.exec(html)) !== null) {
                var p = parseJsonLiteral(m[1]);
                if (p && p.src && /\.m3u8/i.test(p.src)) players.push(p);
            }

            if (!players.length) {
                var decoded = jsUnescape(decodeEntities(html));
                var fbRe = /"src":"(https?:\/\/[^"]+\.m3u8)"/g;
                while ((m = fbRe.exec(decoded)) !== null) players.push({ src: m[1] });
            }

            if (!players.length) return cb(fail('NOT_FOUND', 'Stream tidak ditemukan di halaman episode AniZone.'));

            var streams = players.map(function (p, i) {
                var subs = [];
                var rawSubs = Array.isArray(p.subtitles) ? p.subtitles : [];
                for (var j = 0; j < rawSubs.length; j++) {
                    var s = rawSubs[j];
                    if (s && s.file) subs.push({ url: s.file, label: s.title || ('Subtitle ' + (j + 1)), lang: s.language || 'und' });
                }
                return new StreamResult({
                    url: p.src,
                    quality: 'Auto',
                    source: players.length > 1 ? 'AniZone | Video ' + (i + 1) : 'AniZone',
                    headers: { Referer: BASE + '/' },
                    subtitles: subs.length ? subs : undefined
                });
            });

            cb({ success: true, data: streams });
        } catch (e) {
            cb(fail('PARSE_ERROR', 'Gagal memuat stream AniZone: ' + String(e && e.message ? e.message : e)));
        }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

})();
