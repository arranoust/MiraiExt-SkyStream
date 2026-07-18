(function () {

    // ─── Constants ────────────────────────────────────────────────────────────
    var UA_LIST = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
    ];
    var UA = UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
    var HTML_HEADERS = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    var AJAX_ACTION_NONCE = 'aa1208d27f29ca340c92c66d1926f13f';
    var AJAX_ACTION_FETCH = '2a3505c93b0035d3f455df82bf976b84';

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function forceString(val) {
        if (val == null)             return '';
        if (typeof val === 'string') return val;
        if (typeof val === 'object') {
            if (val.body != null) return typeof val.body === 'string' ? val.body : String(val.body);
            try { return JSON.stringify(val); } catch (_) { return ''; }
        }
        return String(val);
    }

    function getBody(res) {
        if (!res)                         return '';
        if (typeof res === 'string')      return res;
        if (typeof res.body === 'string') return res.body;
        if (res.body)                     return forceString(res.body);
        return forceString(res);
    }

    function extractAttr(items, attrType) {
        if (!Array.isArray(items)) return [];
        return items.map(function (item) {
            if (item == null)             return '';
            if (typeof item === 'string') return item;
            if (typeof item === 'object') {
                if (attrType === 'text') return forceString(item.text || item.html || '');
                if (attrType === 'html') return forceString(item.html || item.text || '');
                return forceString(item.attr || item[attrType] || '');
            }
            return String(item);
        });
    }

    async function parseHtml(html, selector, attrType) {
        try {
            var raw = await parse_html(html, selector, attrType);
            if (!Array.isArray(raw)) return [];
            return extractAttr(raw, attrType);
        } catch (_) { return []; }
    }

    function isPlayable(url) {
        return /\.(mp4|m3u8|webm|mkv)(\?|$)/i.test(url);
    }

    async function rawGet(url, headers) {
        return http_get(url, headers || HTML_HEADERS);
    }

    function decodeHtmlEntities(str) {
        return str
            .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
            .replace(/&#8216;/g, '\u2018').replace(/&#8217;/g, '\u2019')
            .replace(/&#8220;/g, '\u201C').replace(/&#8221;/g, '\u201D')
            .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&#\d+;/g, '').trim();
    }

    function safeAtob(str) {
        try {
            if (typeof atob === 'function') return atob(str);
            return Buffer.from(str, 'base64').toString('utf8');
        } catch (_) { return null; }
    }

    function extractSeason(href, rawTitle) {
        var fromUrl = href.match(/season[- _](\d+)/i)?.[1];
        if (fromUrl) return parseInt(fromUrl, 10);
        var fromTitle = rawTitle.match(/season\s+(\d+)/i)?.[1]
            || rawTitle.match(/s(\d{2,})\s*ep/i)?.[1];
        if (fromTitle) return parseInt(fromTitle, 10);
        return 1;
    }

    // ─── Resolvers ────────────────────────────────────────────────────────────
    async function resolveWithUnpack(embedUrl, referer) {
        try {
            var body = getBody(await rawGet(embedUrl, { ...HTML_HEADERS, Referer: referer }));
            if (!body) return null;
            var src = body;
            if (body.includes('eval(function(p,a,c,k,e')) {
                try { src = getAndUnpack(body); } catch (_) {}
            }
            var m = src.match(/["'](https?:\/\/[^"']+\.m3u8[^"']{0,300}?)["']/i)
                 || src.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i)
                 || src.match(/<source[^>]+src=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i)
                 || src.match(/["'](https?:\/\/[^"']{15,}\.mp4[^"']{0,200}?)["']/i);
            if (!m) return null;
            var origin = '';
            try { origin = new URL(embedUrl).origin + '/'; } catch (_) { origin = referer; }
            return { url: m[1], referer: origin };
        } catch (_) { return null; }
    }

    async function resolveFiledon(embedUrl) {
        try {
            var body = getBody(await rawGet(embedUrl, { ...HTML_HEADERS, Referer: manifest.baseUrl + '/' }));
            if (!body) return null;
            var m = body.match(/data-page="([^"]+)"/);
            if (!m) return null;
            var page = JSON.parse(
                m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                    .replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            );
            var mp4 = page?.props?.url;
            if (!mp4 || typeof mp4 !== 'string') return null;
            if (!isPlayable(mp4) && !mp4.includes('.r2.')) return null;
            return { url: mp4, referer: 'https://filedon.co/' };
        } catch (_) { return null; }
    }

    async function resolveBlogger(embedUrl) {
        try {
            var body = getBody(await rawGet(embedUrl, { 'User-Agent': UA }));
            if (!body) return null;
            var m = body.match(/"play_url"\s*:\s*"([^"]+)"/) || body.match(/"iurl"\s*:\s*"([^"]+)"/);
            if (!m) return null;
            return {
                url: m[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\\//g, '/'),
                referer: 'https://www.blogger.com/'
            };
        } catch (_) { return null; }
    }

    async function resolveOndesu(embedUrl, episodeReferer) {
        try {
            var body = getBody(await rawGet(embedUrl, { ...HTML_HEADERS, Referer: episodeReferer }));
            if (!body) return null;
            var m = body.match(/<iframe[^>]+src=["']([^"']*draft\.blogger\.com[^"']*)["']/i)
                 || body.match(/<iframe[^>]+src=["'](https?:\/\/[^"']*blogger\.com\/video[^"']*)["']/i);
            if (!m?.[1]) return null;
            if (m[1].includes('googlevideo.com')) return { url: m[1], referer: 'https://www.blogger.com/' };
            return resolveBlogger(m[1]);
        } catch (_) { return null; }
    }

    // ─── resolvePixelDrainDownload ────────────────────────────────────────────
    async function resolvePixelDrainDownload(episodeUrl) {
        try {
            var html = getBody(await rawGet(episodeUrl));

            var dlStart = html.indexOf('<div class="download">');
            if (dlStart === -1) return [];
            var dlEnd = html.indexOf('<div class="keyword">', dlStart);
            var dlHtml = dlEnd > -1 ? html.substring(dlStart, dlEnd) : html.substring(dlStart, dlStart + 10000);

            var parts = dlHtml.split(/<li>/i).slice(1);
            var tasks = [];
            for (var i = 0; i < parts.length; i++) {
                var li = parts[i];
                if (!li.includes('Pdrain')) continue;
                var qm = li.match(/<strong>([^<]+)<\/strong>/);
                var um = li.match(/href="(https:\/\/link\.desustream\.com\/[^"]+)"[^>]*>Pdrain/i);
                if (qm && um) tasks.push({ quality: qm[1].trim(), wrapperUrl: um[1] });
            }
            if (!tasks.length) return [];

            var results = await Promise.all(tasks.map(async function (t) {
                try {
                    var body    = getBody(await http_get(t.wrapperUrl, { 'User-Agent': UA, 'Accept': '*/*' }));
                    var idMatch = body.match(/pixeldrain\.com\/u\/([a-zA-Z0-9]+)/)
                               || body.match(/["']\/api\/file\/([a-zA-Z0-9]+)["']/);
                    if (!idMatch) return null;
                    return new StreamResult({
                        url:     'https://pixeldrain.com/api/file/' + idMatch[1],
                        quality: t.quality,
                        source:  'PixelDrain | ' + t.quality,
                        headers: { Referer: 'https://pixeldrain.com/' }
                    });
                } catch (_) { return null; }
            }));
            return results.filter(Boolean);
        } catch (_) { return []; }
    }

    async function resolveAny(embedUrl, serverName, episodeReferer) {
        try {
            if (isPlayable(embedUrl)) {
                try { return { url: embedUrl, referer: new URL(embedUrl).origin + '/' }; }
                catch (_) { return { url: embedUrl, referer: episodeReferer }; }
            }
            if (embedUrl.includes('archive.org'))                                          return { url: embedUrl, referer: 'https://archive.org/' };
            if (embedUrl.includes('googlevideo'))                                          return { url: embedUrl, referer: 'https://www.blogger.com/' };
            if (embedUrl.includes('mega.nz'))                                              return null;
            if (embedUrl.includes('filedon') || serverName.includes('filedon'))            return resolveFiledon(embedUrl);
            if (embedUrl.includes('blogger.com/video') || serverName.includes('blogger'))  return resolveBlogger(embedUrl);
            if (embedUrl.includes('ondesu') || serverName.includes('ondesu'))              return resolveOndesu(embedUrl, episodeReferer);
            return resolveWithUnpack(embedUrl, episodeReferer);
        } catch (_) { return null; }
    }

    // ─── AniList ──────────────────────────────────────────────────────────────
    async function getAniListData(title) {
        if (!title) return null;
        var query = `query ($search: String) {
            Media(search: $search, type: ANIME) {
                id
                idMal
                characters(sort: ROLE, perPage: 15) {
                    edges { role node { name { full native } image { large medium } } }
                }
            }
        }`;
        try {
            var res   = await http_post('https://graphql.anilist.co',
                { 'Content-Type': 'application/json', Accept: 'application/json' },
                JSON.stringify({ query, variables: { search: title } })
            );
            var data  = typeof res?.body === 'string' ? JSON.parse(res.body) : res?.body;
            var media = data?.data?.Media;
            if (!media) return null;
            return {
                idMal:     media.idMal ? String(media.idMal) : null,
                idAniList: media.id    ? String(media.id)    : null,
                characters: media.characters?.edges ?? []
            };
        } catch (_) { return null; }
    }

    // ─── AniZip ───────────────────────────────────────────────────────────────
    async function getAniZipByMalId(malId) {
        if (!malId) return null;
        try {
            var res  = await http_get('https://api.ani.zip/mappings?mal_id=' + malId,
                { 'User-Agent': UA, Accept: 'application/json' });
            var data = typeof res?.body === 'string' ? JSON.parse(res.body) : res?.body;
            return data?.episodes ? data : null;
        } catch (_) { return null; }
    }

    // ─── fetchMetadata ────────────────────────────────────────────────────────
    async function fetchMetadata(titles) {
        var validTitles = titles.filter(Boolean);
        if (!validTitles.length) return { aniListData: null, aniZip: null };
        var aniListData = await Promise.all(validTitles.map(getAniListData))
            .then(function (results) { return results.find(function (r) { return r?.idMal; }) || null; });
        var aniZip = aniListData?.idMal ? await getAniZipByMalId(aniListData.idMal) : null;
        return { aniListData, aniZip };
    }

    // ─── Shared list page parser ──────────────────────────────────────────────
    async function parseListPage(url) {
        try {
            var html    = getBody(await rawGet(url));
            var links   = await parseHtml(html, '.venz li .detpost .thumb a',    'href');
            var titles  = await parseHtml(html, '.venz li .detpost h2.jdlflm',  'text');
            var posters = await parseHtml(html, '.venz li .detpost .thumbz img', 'src');
            return links.map(function (href, i) {
                return new MultimediaItem({
                    title:     (titles[i] || 'No Title').trim(),
                    url:       href,
                    posterUrl: posters[i] || '',
                    type:      'anime'
                });
            });
        } catch (_) { return []; }
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var base = manifest.baseUrl;
            var [og, cp] = await Promise.all([
                parseListPage(base + '/ongoing-anime/'),
                parseListPage(base + '/complete-anime/')
            ]);
            var result = {};
            if (og.length) result['Ongoing Anime']   = og;
            if (cp.length) result['Completed Anime'] = cp;
            if (!Object.keys(result).length)
                return cb({ success: false, error: 'Gagal memuat homepage.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var html  = getBody(await rawGet(manifest.baseUrl + '/?s=' + encodeURIComponent(query) + '&post_type=anime'));
            var items = [];

            var ulMatch = html.match(/<ul[^>]+class=["'][^"']*chivsrc[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
            if (ulMatch) {
                var liParts = ulMatch[1].split(/<li[^>]*>/i).slice(1);
                for (var [i, li] of liParts.entries()) {
                    var href   = li.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["']/i)?.[1]?.trim();
                    var title  = li.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i)?.[1]?.trim();
                    var poster = li.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1]?.trim();
                    if (!href || !/^https?:\/\//i.test(href)) continue;
                    items.push(new MultimediaItem({
                        title:     decodeHtmlEntities(title || ('Anime ' + (i + 1))),
                        url:       href,
                        posterUrl: poster || '',
                        type:      'anime'
                    }));
                }
            }

            if (!items.length) {
                var links   = await parseHtml(html, '.venz li .detpost .thumb a',    'href');
                var titles  = await parseHtml(html, '.venz li .detpost h2.jdlflm',  'text');
                var posters = await parseHtml(html, '.venz li .detpost .thumbz img', 'src');
                items = links.map(function (href, i) {
                    return new MultimediaItem({
                        title:     (titles[i] || 'Unknown').trim(),
                        url:       href,
                        posterUrl: posters[i] || '',
                        type:      'anime'
                    });
                });
            }

            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var html = getBody(await rawGet(url));

            var rawInfo = await parseHtml(html, '.infozingle p span', 'text');
            var infoMap = {};
            for (var row of rawInfo) {
                var colon = row.indexOf(':');
                if (colon === -1) continue;
                var label = row.slice(0, colon).trim().toLowerCase();
                var value = row.slice(colon + 1).trim();
                if (label && value) infoMap[label] = value;
            }

            var animeTitle    = infoMap['judul']    || '';
            var englishTitle  = infoMap['english']  || infoMap['judul inggris'] || '';
            var japaneseTitle = infoMap['japanese'] || infoMap['judul jepang']  || '';

            if (!animeTitle) {
                var seg = url.split('/').filter(Boolean);
                animeTitle = (seg.at(-1) || 'Anime Detail').replace(/-/g, ' ')
                    .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
            }

            var searchTitles = [englishTitle, animeTitle, japaneseTitle].filter(Boolean);

            var [
                rawPoster,
                rawSyn,
                epLinks,
                epTitles,
                { aniListData, aniZip }
            ] = await Promise.all([
                parseHtml(html, '.fotoanime img', 'src'),
                parseHtml(html, '.sinopc p', 'text'),
                parseHtml(html, '.episodelist ul li a', 'href'),
                parseHtml(html, '.episodelist ul li a', 'text'),
                fetchMetadata(searchTitles)
            ]);

            var poster    = rawPoster[0] || '';
            var synopsis  = rawSyn.join('\n\n').trim();
            var isOngoing = html.includes('Ongoing');

            var validLinks = [], validTitles = [];
            for (var [i, href] of epLinks.entries()) {
                if (href.includes('/episode/')) {
                    validLinks.push(href);
                    validTitles.push(epTitles[i]);
                }
            }
            validLinks.reverse();
            validTitles.reverse();

            var cast = (aniListData?.characters ?? []).map(function (edge) {
                var node = edge.node;
                if (!node) return null;
                return new Actor({
                    name:  node.name?.full || node.name?.native || 'Unknown',
                    role:  edge.role || 'SUPPORTING',
                    image: node.image?.large || node.image?.medium || ''
                });
            }).filter(Boolean);

            var resolvedTitle = aniZip?.titles?.en
                || aniZip?.titles?.['x-jat']
                || aniZip?.titles?.ja
                || animeTitle;

            var episodes = validLinks.map(function (href, idx) {
                var rawEpTitle = (validTitles[idx] || '')
                    .replace(/\s*subtitle\s+indonesia\s*/gi, '')
                    .trim();

                var epNumRaw = parseFloat(href.match(/episode[- ](\d+(?:\.\d+)?)/i)?.[1])
                    || parseFloat(rawEpTitle.match(/episode\s+(\d+(?:\.\d+)?)/i)?.[1])
                    || parseFloat(rawEpTitle.match(/(\d+(?:\.\d+)?)(?!.*\d)/)?.[1])
                    || (idx + 1);

                var epNum  = Number.isFinite(epNumRaw) ? Math.round(epNumRaw) : (idx + 1);
                var season = extractSeason(href, rawEpTitle);

                var aniEp = aniZip?.episodes?.[String(epNum)]
                    || aniZip?.episodes?.[String(Math.floor(epNumRaw ?? epNum))]
                    || null;

                return new Episode({
                    name:        aniEp?.title?.en || aniEp?.title?.['x-jat'] || aniEp?.title?.ja || rawEpTitle || ('Episode ' + epNum),
                    url:         href,
                    season,
                    episode:     epNum,
                    dubStatus:   'subbed',
                    posterUrl:   aniEp?.image || poster,
                    description: aniEp?.overview ? String(aniEp.overview) : '',
                    runtime:     aniEp?.runtime ? Math.round(aniEp.runtime) : undefined
                });
            });

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       resolvedTitle,
                    url,
                    posterUrl:   poster,
                    type:        'anime',
                    status:      isOngoing ? 'ongoing' : 'completed',
                    description: synopsis,
                    cast,
                    episodes,
                    syncData:    aniListData?.idMal ?
                        { mal: aniListData.idMal, anilist: aniListData.idAniList } : undefined
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var html         = getBody(await rawGet(url));
            var dataContents = await parseHtml(html, '.mirrorstream ul li a', 'data-content');
            var serverNames  = await parseHtml(html, '.mirrorstream ul li a', 'text');

            if (!dataContents.length)
                return cb({ success: false, error: 'Tidak ditemukan mirror stream.' });

            var ajaxUrl     = manifest.baseUrl + '/wp-admin/admin-ajax.php';
            var ajaxHeaders = {
                'Content-Type':     'application/x-www-form-urlencoded',
                'User-Agent':       UA,
                'Referer':          url,
                'X-Requested-With': 'XMLHttpRequest'
            };

            var nonce = '';
            try {
                var nonceRes  = await http_post(ajaxUrl, ajaxHeaders, 'action=' + AJAX_ACTION_NONCE);
                var nonceJson = JSON.parse(getBody(nonceRes));
                nonce = forceString(nonceJson.data || '');
            } catch (e) {
                console.error('OtakuDesu: gagal mengambil nonce:', e);
            }

            if (!nonce) return cb({ success: false, error: 'Gagal mengambil nonce.' });

            var [mirrorStreams, pdStreams] = await Promise.all([
                (async function () {
                    var tasks = dataContents.map(async function (dataContent, i) {
                        try {
                            dataContent = (dataContent || '').trim();
                            if (!dataContent || dataContent === '#') return null;

                            var decoded = safeAtob(dataContent);
                            if (!decoded) return null;

                            var tokenObj = null;
                            try { tokenObj = JSON.parse(decoded); } catch (_) { return null; }
                            if (tokenObj?.id === undefined) return null;

                            var postBody = 'id='     + encodeURIComponent(tokenObj.id)
                                        + '&i='     + encodeURIComponent(tokenObj.i)
                                        + '&q='     + encodeURIComponent(tokenObj.q)
                                        + '&nonce=' + encodeURIComponent(nonce)
                                        + '&action=' + AJAX_ACTION_FETCH;

                            var embedRes  = await http_post(ajaxUrl, ajaxHeaders, postBody);
                            var embedJson = JSON.parse(getBody(embedRes));
                            if (!embedJson?.data) return null;

                            var iframeHtml = safeAtob(forceString(embedJson.data));
                            if (!iframeHtml) return null;

                            var embedUrl = iframeHtml.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1]
                                        || (/^https?:\/\//i.test(iframeHtml.trim()) ? iframeHtml.trim() : '');
                            if (!embedUrl) return null;

                            var serverName = (serverNames[i] || '').trim().toLowerCase();
                            var resolved   = await resolveAny(embedUrl, serverName, url);
                            if (!resolved?.url) return null;

                            return new StreamResult({
                                url:     resolved.url,
                                quality: tokenObj.q || undefined,
                                source:  serverName + (tokenObj.q ? ' | ' + tokenObj.q + '' : ''),
                                headers: { 'User-Agent': UA, Referer: resolved.referer || url }
                            });
                        } catch (_) { return null; }
                    });
                    return (await Promise.all(tasks)).filter(Boolean);
                })(),
                resolvePixelDrainDownload(url)
            ]);

            var results = [...mirrorStreams, ...pdStreams];

            if (!results.length)
                return cb({ success: false, error: 'Tidak ditemukan link streaming.' });

            cb({ success: true, data: results });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams  = loadStreams;

})();