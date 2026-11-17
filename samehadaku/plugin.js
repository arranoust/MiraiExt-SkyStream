// Direct dist path: the deploy bundler uses esbuild platform "neutral", which
// ignores the package "main" field and cannot resolve the bare package name.
import { PixelDrain } from 'skystream-extractors/dist/extractors/pixel_drain.js';

(function () {

    var BASE_HEADERS = {
        'User-Agent': 'okhttp/4.12.0'
    };

    var AJAX_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': manifest.baseUrl + '/'
    };

    var pixelDrain = new PixelDrain();

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

    function fixUrl(url) {
        if (!url) return null;
        var s = String(url).trim();
        if (s.startsWith('//')) return 'https:' + s;
        if (s.startsWith('/')) return manifest.baseUrl + s;
        return s;
    }

    function cleanTitle(t) {
        return String(t || '')
            .replace(/&[a-z]+;|&#\d+;/gi, ' ')
            .replace(/\s*[–—-]\s*Samehadaku.*$/i, '')
            .replace(/\bsub(?:\s+)?indo\b/gi, '')
            .replace(/\bnonton\b|\bstreaming\b|\bdownload\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Samehadaku poster filenames carry the AniList ID, e.g.
    // bx198727-xxxx-212x300.jpg or 148216-212x300.jpg. Using it avoids fuzzy
    // title matching (which used to map "Cour 2" to season 1).
    function extractAniListId(posterUrl) {
        if (!posterUrl) return null;
        var name = String(posterUrl).split('/').pop();
        var m = name.match(/bx(\d+)-/i) || name.match(/^(\d{5,})-\d+x\d+/i);
        return m ? m[1] : null;
    }

    function getStatus(t) {
        var s = (t || '').toLowerCase();
        return (s.includes('complet') || s.includes('finished')) ? 'completed' : 'ongoing';
    }

    function fixQuality(label) {
        var u = (label || '').toUpperCase();
        if (u.includes('4K')) return '2160p';
        if (u.includes('1080') || u.includes('FULLHD')) return '1080p';
        if (u.includes('720') || u.includes('MP4HD')) return '720p';
        if (u.includes('480')) return '480p';
        if (u.includes('360')) return '360p';
        return label || 'Auto';
    }

    var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

    function toIsoDate(s) {
        if (!s) return undefined;
        var m = String(s).match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/i);
        if (!m) return undefined;
        var mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
        if (!mo) return undefined;
        return m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(parseInt(m[1], 10)).padStart(2, '0');
    }

    function detailValue(body, label) {
        try {
            var re = new RegExp('<span[^>]*>\\s*' + label + '\\s*<\\/span>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>', 'i');
            var m = body.match(re);
            return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
        } catch (_) { return null; }
    }

    function uniq(list) {
        var out = [], seen = Object.create(null);
        (list || []).forEach(function (v) {
            if (!v) return;
            var k = String(v).toLowerCase();
            if (seen[k]) return;
            seen[k] = true;
            out.push(v);
        });
        return out;
    }

    // ─── ani.zip helpers ──────────────────────────────────────────────────────

    function asImageArray(images) {
        if (!images) return [];
        if (Array.isArray(images)) return images;
        return Object.keys(images).map(function (k) { return images[k]; });
    }

    function pickImage(data, coverType) {
        var imgs = asImageArray(data && data.images);
        for (var i = 0; i < imgs.length; i++) {
            if (imgs[i] && String(imgs[i].coverType || '').toLowerCase() === coverType.toLowerCase()) {
                return imgs[i].url || null;
            }
        }
        return null;
    }

    function pickTitle(titles) {
        if (!titles) return null;
        return titles.en || titles['x-jat'] || titles.ja || titles.native || titles.romaji || null;
    }

    function pickEpisodeTitle(ep) {
        if (!ep) return null;
        return pickTitle(ep.title) || null;
    }

    // ─── Individual resolvers ────────────────────────────────────────────────

    async function resolveFiledon(embedUrl) {
        try {
            var slug = embedUrl.split('/embed/').pop().split(/[/?]/)[0];
            if (!slug) return null;
            var res = await http_get('https://filedon.co/embed/' + slug, {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': manifest.baseUrl + '/'
            });
            var m = getBody(res).match(/id="app"\s+data-page="([^"]+)"/);
            if (!m) return null;
            var json = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
            return json?.props?.url || json?.url || null;
        } catch (_) { return null; }
    }

    async function resolveWibufile(iframeUrl, label) {
        try {
            var res = await http_get(iframeUrl, {
                'Referer': manifest.baseUrl + '/',
                'User-Agent': BASE_HEADERS['User-Agent']
            });
            var m = getBody(res).match(/sources:\s*(\[.*?\])/s);
            if (!m) return null;
            var sources = JSON.parse(m[1].replace(/\\\//g, '/'));
            return sources.map(function (s) {
                return new StreamResult({
                    url: s.file,
                    quality: fixQuality(s.label || label),
                    source: label.trim(),
                    headers: { Referer: manifest.baseUrl + '/' }
                });
            });
        } catch (_) { return null; }
    }

    // ─── PixelDrain (built-in extractor) ──────────────────────────────────────

    async function resolvePixelDrain(pageUrl, quality) {
        try {
            var links = await pixelDrain.getUrl(pageUrl, pageUrl);
            if (!links || !links.length || !links[0].url) return [];
            return [new StreamResult({
                url: links[0].url,
                quality: quality,
                source: 'PixelDrain ' + quality,
                headers: links[0].headers || { Referer: pageUrl }
            })];
        } catch (_) { return []; }
    }

    // ─── Embed player (online streaming) ─────────────────────────────────────

    async function resolveStream(iframeUrl, label) {
        try {
            if (iframeUrl.startsWith('/embed/')) iframeUrl = 'https://filedon.co' + iframeUrl;
            if (iframeUrl.includes('filedon.co/embed/')) {
                var url = await resolveFiledon(iframeUrl);
                return url ? new StreamResult({ url, quality: fixQuality(label), source: label.trim(), headers: { Referer: 'https://filedon.co/' } }) : null;
            }
            if (iframeUrl.includes('api.wibufile.com/embed/')) return resolveWibufile(iframeUrl, label);
            if (iframeUrl.includes('wibufile.com')) return new StreamResult({ url: iframeUrl, quality: fixQuality(label), source: label.trim(), headers: { Referer: manifest.baseUrl + '/' } });
            return null;
        } catch (_) { return null; }
    }

    async function resolveEmbedButtons(body) {
        var buttons = [];
        var btnRegex = /data-post="(\d+)"[^>]*data-nume="([^"]+)"[^>]*data-type="([^"]+)"[^>]*>[\s\S]*?<span[^>]*>([^<]*)<\/span>/gi;
        var m;
        while ((m = btnRegex.exec(body)) !== null)
            buttons.push({ post: m[1], nume: m[2], type: m[3], label: m[4].trim() });
        if (!buttons.length) return [];

        var results = await Promise.all(buttons.map(async function (btn) {
            try {
                var ajax = await http_post(
                    manifest.baseUrl + '/wp-admin/admin-ajax.php', AJAX_HEADERS,
                    'action=player_ajax&post=' + btn.post + '&nume=' + encodeURIComponent(btn.nume) + '&type=' + encodeURIComponent(btn.type)
                );
                var embed = getBody(ajax);
                try { var p = typeof embed === 'string' ? JSON.parse(embed) : embed; if (p.embed) embed = p.embed; } catch (_) { }
                var src = embed.match(/src=["']([^"']+)["']/i);
                return src ? resolveStream(src[1].replace(/&amp;/g, '&'), btn.label) : null;
            } catch (_) { return null; }
        }));

        var flat = [];
        results.forEach(function (r) {
            if (!r) return;
            Array.isArray(r) ? flat.push.apply(flat, r) : flat.push(r);
        });
        return flat;
    }

    // ─── Download section ────────────────────────────────────────────────────

    async function resolveDownloadLinks(body) {
        var streams = [];
        var liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        var m;
        while ((m = liRegex.exec(body)) !== null) {
            var block = m[1];
            var qMatch = block.match(/<strong>([^<]+?)\s*<\/strong>/i);
            if (!qMatch) continue;
            var quality = fixQuality(qMatch[1].trim());
            var pd = block.match(/href="(https:\/\/pixeldrain\.com\/u\/[^"]+)"/i);
            if (!pd) continue;
            try {
                streams.push.apply(streams, await resolvePixelDrain(pd[1].replace(/&amp;/g, '&'), quality));
            } catch (e) {
                console.error('Samehadaku: PixelDrain resolver failed:', e);
            }
        }
        return streams;
    }

    // ─── AniList / AniZip ─────────────────────────────────────────────────────

    var ANILIST_FIELDS = 'id idMal title{romaji english native} bannerImage coverImage{extraLarge large} '
        + 'nextAiringEpisode{episode timeUntilAiring}'
        + 'characters(sort:ROLE,perPage:15){edges{role node{name{full}image{large}}}}';

    function mapAniListMedia(media) {
        if (!media) return null;
        return {
            id: String(media.id),
            idMal: media.idMal ? String(media.idMal) : null,
            characters: media.characters?.edges ?? [],
            nextAiring: media.nextAiringEpisode || null,
            bannerUrl: media.bannerImage || null,
            posterUrl: media.coverImage?.extraLarge || media.coverImage?.large || null,
            title: pickTitle(media.title)
        };
    }

    async function queryAniList(query, variables) {
        try {
            var res = await http_post('https://graphql.anilist.co',
                { 'Content-Type': 'application/json', Accept: 'application/json' },
                JSON.stringify({ query: query, variables: variables })
            );
            var data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
            return mapAniListMedia(data?.data?.Media);
        } catch (_) { return null; }
    }

    function getAniListById(id) {
        if (!id) return Promise.resolve(null);
        return queryAniList(
            'query($id:Int){Media(id:$id,type:ANIME){' + ANILIST_FIELDS + '}}',
            { id: parseInt(id, 10) }
        );
    }

    function getAniListByTitle(title) {
        if (!title) return Promise.resolve(null);
        return queryAniList(
            'query($s:String){Media(search:$s,type:ANIME){' + ANILIST_FIELDS + '}}',
            { s: title }
        );
    }

    async function getAniZip(mode, id) {
        if (!id) return null;
        try {
            var res = await http_get('https://api.ani.zip/mappings?' + mode + '=' + encodeURIComponent(id),
                { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' });
            var data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
            return data?.mappings ? data : null;
        } catch (_) { return null; }
    }

    function getAniZipByMalId(malId) { return getAniZip('mal_id', malId); }
    function getAniZipByAniListId(id) { return getAniZip('anilist_id', id); }

    // ─── getHome ──────────────────────────────────────────────────────────────

    var HOME_PAGES = [
        { key: 'New Episodes',    path: '/anime-terbaru/',                                        latest: true  },
        { key: 'Ongoing Anime',   path: '/daftar-anime-2/?status=Currently+Airing&order=latest', latest: false },
        { key: 'Completed Anime', path: '/daftar-anime-2/?status=Finished+Airing&order=latest',  latest: false },
        { key: 'Movies',          path: '/daftar-anime-2/?type=Movie&order=latest',               latest: false }
    ];

    async function getHome(cb) {
        try {
            var results = await Promise.all(HOME_PAGES.map(async function (cat) {
                try {
                    var res = await http_get(manifest.baseUrl + cat.path, BASE_HEADERS);
                    var body = getBody(res);
                    var items = [];

                    if (cat.latest) {
                        var links   = await parse_html(body, 'div.thumb a', 'href');
                        var titles  = await parse_html(body, 'div.thumb a', 'title');
                        var posters = await parse_html(body, 'div.thumb img', 'src');
                        for (var i = 0; i < links.length; i++) {
                            var href = links[i]?.attr;
                            if (!href) continue;
                            items.push(new MultimediaItem({
                                title:     titles[i]?.attr || 'Anime',
                                url:       fixUrl(href),
                                posterUrl: fixUrl(posters[i]?.attr || ''),
                                type:      'anime'
                            }));
                        }
                    } else {
                        var links    = await parse_html(body, 'div.animposx > a', 'href');
                        var titles   = await parse_html(body, 'div.animposx .data .title h2', 'text');
                        var posters  = await parse_html(body, 'div.animposx img', 'src');
                        var statuses = await parse_html(body, 'div.animposx .data .type', 'text');
                        for (var i = 0; i < links.length; i++) {
                            var href  = links[i]?.attr;
                            var title = titles[i]?.text?.trim();
                            if (!href || !title) continue;
                            var rawStatus = (statuses[i]?.text || '').trim().toLowerCase();
                            var status = rawStatus.includes('complet') || rawStatus.includes('end') ? 'completed' : 'ongoing';
                            items.push(new MultimediaItem({
                                title:     title,
                                url:       fixUrl(href),
                                posterUrl: fixUrl(posters[i]?.attr || ''),
                                type:      'anime',
                                status:    status
                            }));
                        }
                    }

                    return { key: cat.key, list: items };
                } catch (e) {
                    console.error('Samehadaku: gagal memuat kategori ' + cat.key + ':', e);
                    return { key: cat.key, list: [] };
                }
            }));

            // The app hero carousel prefers the "Trending" key. Only posters
            // with an embedded AniList ID can be enriched with an ani.zip logo,
            // so build that row from those items and leave other rows intact.
            var trendingCandidates = [], trendingSeen = Object.create(null);
            ['Completed Anime', 'Movies', 'Ongoing Anime'].forEach(function (key) {
                var group = (results.find(function (r) { return r.key === key; }) || {}).list || [];
                group.forEach(function (item) {
                    var id = extractAniListId(item.posterUrl);
                    if (!id || trendingSeen[id]) return;
                    trendingSeen[id] = true;
                    trendingCandidates.push({ item: item, id: id });
                });
            });
            trendingCandidates = trendingCandidates.slice(0, 7);

            var trending = await Promise.all(trendingCandidates.map(async function (entry) {
                try {
                    var zip = await getAniZipByAniListId(entry.id);
                    return new MultimediaItem({
                        title:      entry.item.title,
                        url:        entry.item.url,
                        posterUrl:  entry.item.posterUrl,
                        type:       entry.item.type,
                        status:     entry.item.status,
                        logoUrl:    pickImage(zip, 'Clearlogo') || undefined,
                        bannerUrl:  pickImage(zip, 'Banner') || pickImage(zip, 'Fanart') || undefined
                    });
                } catch (_) { return entry.item; }
            }));

            var data = {};
            results.forEach(function (r) { if (r.list.length) data[r.key] = r.list; });
            if (trending.length) data.Trending = trending;
            if (!Object.keys(data).length) return cb(fail('HOME_FETCH_FAILED', 'Gagal memuat homepage Samehadaku.'));
            cb({ success: true, data: data });
        } catch (e) { cb(fail('HOME_FETCH_FAILED', String(e))); }
    }

    // ─── search ───────────────────────────────────────────────────────────────

    async function search(query, cb) {
        try {
            var res     = await http_get(manifest.baseUrl + '/?s=' + encodeURIComponent(query), BASE_HEADERS);
            var body    = getBody(res);
            var links   = await parse_html(body, 'div.animposx > a', 'href');
            var titles  = await parse_html(body, 'div.animposx .data .title h2', 'text');
            var posters = await parse_html(body, 'div.animposx img', 'src');
            var items = [];
            for (var i = 0; i < links.length; i++) {
                var href  = links[i]?.attr;
                var title = titles[i]?.text?.trim();
                if (!href || !title) continue;
                items.push(new MultimediaItem({
                    title:     title,
                    url:       fixUrl(href),
                    posterUrl: fixUrl(posters[i]?.attr || ''),
                    type:      'anime'
                }));
            }
            cb({ success: true, data: items });
        } catch (e) { cb(fail('SEARCH_FAILED', String(e))); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────

    async function load(url, cb) {
        try {
            var res  = await http_get(url, BASE_HEADERS);
            var body = getBody(res);

            // Episode pages resolve to their parent anime via breadcrumb.
            if (!/\/anime\//i.test(url) || /-episode-\d+|-end\//i.test(url)) {
                var crumbs = await parse_html(body,
                    '#breadcrumbs a[href*="/anime/"], nav[aria-label="Breadcrumb"] a[href*="/anime/"]', 'href');
                var detailUrl = null;
                for (var c = 0; c < crumbs.length; c++) {
                    if (crumbs[c]?.attr && /\/anime\//i.test(crumbs[c].attr)) { detailUrl = crumbs[c].attr; break; }
                }
                if (detailUrl) {
                    url  = fixUrl(detailUrl);
                    res  = await http_get(url, BASE_HEADERS);
                    body = getBody(res);
                }
            }

            var [
                ogTitleArr, h1Arr, ogImageArr, imageSrcArr, descArr,
                trailerArr, recLinks, recTitles, recPosters
            ] = await Promise.all([
                parse_html(body, 'meta[property="og:title"]', 'content'),
                parse_html(body, 'h1[itemprop="headline"]', 'text'),
                parse_html(body, 'meta[property="og:image"]', 'content'),
                parse_html(body, 'link[rel="image_src"]', 'href'),
                parse_html(body, '.entry-content p', 'text'),
                parse_html(body, '.trailer-anime iframe, iframe[src*="youtube"]', 'src'),
                parse_html(body, '.recom-section .animposx a[href*="/anime/"]', 'href'),
                parse_html(body, '.recom-section .animposx .data .title h2', 'text'),
                parse_html(body, '.recom-section .animposx img', 'src')
            ]);

            var titleTag = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
            var siteTitle = cleanTitle(ogTitleArr[0]?.attr) || cleanTitle(h1Arr[0]?.text) || cleanTitle(titleTag);
            var sitePoster = fixUrl(ogImageArr[0]?.attr || imageSrcArr[0]?.attr || '');

            // Genres: only the block next to .entry-content, before recommendations.
            var metaStart = body.indexOf('entry-content');
            var metaEnd   = body.indexOf('recom-section', metaStart);
            var metaSlice = metaStart >= 0
                ? body.slice(metaStart, metaEnd > metaStart ? metaEnd : Math.min(body.length, metaStart + 12000))
                : body;
            var tagArr = await parse_html(metaSlice, 'a[href*="/genre/"]', 'text');
            var tags = uniq(tagArr.map(function (t) { return (t?.text || '').trim(); })).slice(0, 12);

            // Episodes: the list card between "List Episode" and "Detail Anime".
            var epStart = body.indexOf('List Episode');
            var epEnd   = body.indexOf('Detail Anime', epStart);
            var epSlice = epStart >= 0
                ? body.slice(epStart, epEnd > epStart ? epEnd : Math.min(body.length, epStart + 200000))
                : body;
            // Movies often use "<slug>-end/" instead of "<slug>-episode-N/".
            var EPISODE_LINK = 'a[href*="-episode-"], a[href$="-end/"]';
            var epHrefs = await parse_html(epSlice, 'h4 ' + EPISODE_LINK, 'href');
            if (!epHrefs.length) epHrefs = await parse_html(epSlice, EPISODE_LINK, 'href');
            var epNames = await parse_html(epSlice, 'h4 ' + EPISODE_LINK, 'text');
            var siteDates = [], dm, dRe = /text-\[11px\][^>]*>\s*([^<]+?)\s*<\/span>/gi;
            while ((dm = dRe.exec(epSlice)) !== null) siteDates.push(dm[1].trim());

            var statusRaw   = detailValue(body, 'Status');
            var durationRaw = detailValue(body, 'Duration');
            var released    = detailValue(body, 'Released');
            var yearMatch   = released && released.match(/(\d{4})/);
            var scoreMatch  = body.match(/font-extrabold[^>]*>\s*([\d.]+)\s*<\/span>/i);

            var siteDesc   = (descArr[0]?.text || '').replace(/\s+/g, ' ').trim();

            // Prefer the AniList ID embedded in the site poster filename.
            // Fall back to the Japanese title on the detail page, then the
            // site title verbatim. Do not strip Cour/Part/Movie anymore.
            var aniListData = await getAniListById(extractAniListId(sitePoster));
            if (!aniListData) {
                var candidates = uniq([detailValue(body, 'Japanese'), siteTitle].filter(Boolean));
                for (var ci = 0; ci < candidates.length && !aniListData; ci++) {
                    aniListData = await getAniListByTitle(candidates[ci]);
                }
            }
            var aniZip = aniListData?.idMal ? await getAniZipByMalId(aniListData.idMal) : null;

            var recommendations = recLinks.map(function (h, i) {
                if (!h?.attr) return null;
                return new MultimediaItem({
                    title:     cleanTitle(recTitles[i]?.text) || 'Anime',
                    url:       fixUrl(h.attr),
                    posterUrl: fixUrl(recPosters[i]?.attr || ''),
                    type:      'anime'
                });
            }).filter(Boolean);

            var cast = (aniListData?.characters ?? []).map(function (edge) {
                var node = edge.node;
                if (!node) return null;
                return new Actor({ name: node.name?.full || 'Unknown', role: edge.role || 'SUPPORTING', image: node.image?.large || '' });
            }).filter(Boolean);

            var episodes = [], seenEp = Object.create(null);
            for (var i = 0; i < epHrefs.length; i++) {
                var href = fixUrl(epHrefs[i]?.attr);
                if (!href || seenEp[href]) continue;
                seenEp[href] = true;
                var numMatch = href.match(/episode-(\d+)/i) || (epNames[i]?.text || '').match(/episode\s*(\d+)/i);
                var epNum = numMatch ? parseInt(numMatch[1], 10) : (/-end\//i.test(href) ? 1 : episodes.length + 1);
                var aniEp = aniZip?.episodes ? (aniZip.episodes[String(epNum)] || aniZip.episodes[epNum] || null) : null;

                var epAirDate = aniEp?.airDateUtc
                    ? String(aniEp.airDateUtc).substring(0, 10)
                    : toIsoDate(siteDates[i]);
                var epRuntime = aniEp ? (aniEp.runtime ?? aniEp.length ?? undefined) : undefined;
                var rawRating = aniEp ? (aniEp.rating ?? aniEp.score ?? undefined) : undefined;
                var epRating = (rawRating === undefined || rawRating === null || rawRating === '') ? undefined : parseFloat(rawRating);

                episodes.push(new Episode({
                    name:        pickEpisodeTitle(aniEp) || cleanTitle(epNames[i]?.text) || ('Episode ' + epNum),
                    url:         href,
                    season:      1,
                    episode:     epNum,
                    dubStatus:   'subbed',
                    posterUrl:   aniEp?.image || sitePoster || undefined,
                    description: (aniEp ? (aniEp.overview || aniEp.summary || '') : '').replace(/\s+/g, ' ').trim(),
                    runtime:     epRuntime,
                    rating:      epRating,
                    airDate:     epAirDate
                }));
            }
            episodes.sort(function (a, b) { return (b.episode || 0) - (a.episode || 0); });

            cb({
                success: true,
                data: new MultimediaItem({
                    title:           siteTitle,
                    url:             url,
                    posterUrl:       sitePoster || pickImage(aniZip, 'Poster') || aniListData?.posterUrl || '',
                    logoUrl:         pickImage(aniZip, 'Clearlogo') || undefined,
                    bannerUrl:       pickImage(aniZip, 'Banner') || pickImage(aniZip, 'Fanart') || aniListData?.bannerUrl || undefined,
                    type:            'anime',
                    status:          getStatus(statusRaw),
                    year:            yearMatch ? parseInt(yearMatch[1], 10) : undefined,
                    duration:        durationRaw ? (parseInt(durationRaw, 10) || undefined) : undefined,
                    score:           scoreMatch ? parseFloat(scoreMatch[1]) : undefined,
                    description:     siteDesc,
                    cast:            cast,
                    trailers:        trailerArr[0]?.attr ? [new Trailer({ url: fixUrl(trailerArr[0].attr) })] : [],
                    tags:            tags,
                    recommendations: recommendations,
                    episodes:        episodes,
                    syncData:        aniListData?.idMal ? { mal: aniListData.idMal, anilist: aniListData.id } : undefined,
                    nextAiring:      aniListData?.nextAiring ? new NextAiring({
                        episode:  aniListData.nextAiring.episode,
                        season:   1,
                        unixTime: Math.floor(Date.now() / 1000) + aniListData.nextAiring.timeUntilAiring
                    }) : undefined,
                })
            });
        } catch (e) { cb(fail('LOAD_FAILED', String(e))); }
    }

    // ─── loadStreams ──────────────────────────────────────────────────────────

    async function collectStreams(body) {
        var [embedStreams, dlStreams] = await Promise.all([
            resolveEmbedButtons(body),
            resolveDownloadLinks(body)
        ]);
        return [...(embedStreams || []), ...(dlStreams || [])];
    }

    async function findEpisodeLink(body) {
        var links = await parse_html(body, 'a[href*="-episode-"], a[href$="-end/"]', 'href');
        for (var i = 0; i < links.length; i++) {
            var href = fixUrl(links[i]?.attr);
            if (href && !/\/anime\//i.test(href)) return href;
        }
        return null;
    }

    async function loadStreams(url, cb) {
        try {
            var res  = await http_get(url, BASE_HEADERS);
            var body = getBody(res);
            var flat = await collectStreams(body);

            // A detail page has no download links itself. Follow its first
            // episode/player link so movie playback works from either URL.
            if (!flat.length) {
                var episodeUrl = await findEpisodeLink(body);
                if (episodeUrl && episodeUrl !== url) {
                    var next = await http_get(episodeUrl, BASE_HEADERS);
                    flat = await collectStreams(getBody(next));
                }
            }

            var Q = ['2160p', '1080p', '720p', '480p', '360p'];

            flat.sort(function (a, b) {
                var parse = function (src) {
                    var q = (src || '').match(/2160p|1080p|720p|480p|360p/i)?.[0] || '';
                    var idx = Q.indexOf(q.toLowerCase());
                    return {
                        server: (src || '').replace(q, '').trim().toLowerCase(),
                        qIndex: idx === -1 ? 99 : idx
                    };
                };

                var valA = parse(a.source);
                var valB = parse(b.source);

                return valA.server.localeCompare(valB.server) || (valA.qIndex - valB.qIndex);
            });

            if (!flat.length) return cb(fail('NO_STREAMS', 'Tidak ditemukan stream yang bisa diputar.'));
            cb({ success: true, data: flat });
        } catch (e) { cb(fail('STREAMS_FETCH_FAILED', String(e))); }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

})();
