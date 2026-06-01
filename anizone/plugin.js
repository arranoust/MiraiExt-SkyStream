(function () {

    // ─── Constants & Headers ──────────────────────────────────────────────────
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    var HTML_HEADERS = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    var manifest = {
        baseUrl: "https://anizone.to"
    };

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

    // ─── Regex-based HTML parser 
    function parseLatestEpisodes(html) {
        var items = [];
        var liRegex = /<li[^>]*x-data[^>]*>[\s\S]*?<\/li>/gi;
        var liBlocks = html.match(liRegex) || [];

        for (var i = 0; i < liBlocks.length; i++) {
            var li = liBlocks[i];

            // Episode link
            var epMatch = li.match(/href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+\/\d+)"/i);
            if (!epMatch) continue;
            var epUrl = epMatch[1];

            // Thumbnail
            var thumbMatch = li.match(/<img[^>]+src="([^"]+snapshot\.webp[^"]*)"/i)
                          || li.match(/<img[^>]+src="([^"]+\.webp[^"]*)"/i);
            var thumbnail = thumbMatch ? thumbMatch[1] : '';

            // Anime title
            var animeTitleMatch = li.match(/href="https?:\/\/anizone\.to\/anime\/[a-z0-9]+"[^>]*title="([^"]+)"/i)
                               || li.match(/class="title[^"]*"[^>]*>([^<]+)<\/a>/i);
            var animeTitle = animeTitleMatch ? animeTitleMatch[1].trim() : '';

            // Episode title
            var epTitleMatch = li.match(/href="https?:\/\/anizone\.to\/anime\/[a-z0-9]+\/\d+"[^>]*title="([^"]+)"/i);
            var epTitle = epTitleMatch ? epTitleMatch[1].trim() : '';

            // Anime page URL
            var animeUrlMatch = epUrl.match(/^(https?:\/\/anizone\.to\/anime\/[a-z0-9]+)\/\d+$/i);
            var animeUrl = animeUrlMatch ? animeUrlMatch[1] : '';

            if (!animeTitle || !epUrl) continue;

            items.push({
                animeTitle: animeTitle,
                animeUrl:   animeUrl,
                epUrl:      epUrl,
                epTitle:    epTitle,
                thumbnail:  thumbnail
            });
        }
        return items;
    }

    // ─── Core Methods ─────────────────────────────────────────────────────────

    // Home
    async function getHome(cb) {
        try {
            var base = manifest.baseUrl;
            var html = getBody(await http_get(base, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Gagal memuat HTML.' });

            // ── 1. Latest Episodes
            var epItems = parseLatestEpisodes(html);
            var latestEpisodes = epItems.map(function(ep) {
                return new MultimediaItem({
                    title:     ep.animeTitle + (ep.epTitle ? ' - ' + ep.epTitle : ''),
                    url:       ep.epUrl,
                    posterUrl: ep.thumbnail,
                    type:      'anime'
                });
            });

            // ── 2. Latest Anime (swiper carousel) ──
            var links   = await parseHtml(html, '.swiper-wrapper .swiper-slide .line-clamp-2 a', 'href');
            var titles  = await parseHtml(html, '.swiper-wrapper .swiper-slide .line-clamp-2 a', 'text');
            var posters = await parseHtml(html, '.swiper-wrapper .swiper-slide img', 'src');

            var latestAnime = [];
            var totalItems = Math.min(links.length, titles.length, posters.length);
            for (var i = 0; i < totalItems; i++) {
                var href = links[i];
                if (!href) continue;
                latestAnime.push(new MultimediaItem({
                    title:     (titles[i] || 'No Title').trim(),
                    url:       href.startsWith('http') ? href : base + href,
                    posterUrl: posters[i] || '',
                    type:      'anime'
                }));
            }

            var result = {};
            if (latestEpisodes.length > 0) result['Latest Episodes'] = latestEpisodes;
            if (latestAnime.length > 0)    result['Latest Anime']    = latestAnime;

            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // Search
    async function search(query, cb) {
        var base = manifest.baseUrl;
        var searchUrl = base + '/anime?search=' + encodeURIComponent(query);

        try {
            var html = getBody(await http_get(searchUrl, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Gagal memuat HTML pencarian.' });

            var titles  = await parseHtml(html, '.grid a[href*="/anime/"]', 'text');
            var urls    = await parseHtml(html, '.grid a[href*="/anime/"]', 'href');
            var posters = await parseHtml(html, '.grid img', 'src');

            var results = [];
            var totalItems = Math.min(titles.length, urls.length);

            for (var i = 0; i < totalItems; i++) {
                var href = urls[i];
                if (!href) continue;
                if (/\/anime\/[a-z0-9]+\/\d+$/i.test(href)) continue;
                results.push(new MultimediaItem({
                    title:     (titles[i] || 'No Title').trim(),
                    url:       href.startsWith('http') ? href : base + href,
                    posterUrl: posters[i] || '',
                    type:      'anime'
                }));
            }

            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // Load 
    async function load(url, cb) {
        var base = manifest.baseUrl;

        try {
            var html = getBody(await http_get(url, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Gagal memuat HTML detail anime.' });

            var titles       = await parseHtml(html, 'h1', 'text');
            var posters      = await parseHtml(html, 'img[src*="/images/anime/"]', 'src');
            var descriptions = await parseHtml(html, '.text-slate-100.text-center div', 'text');

            var animeTitle = titles[0] ? titles[0].trim() : 'No Title';
            var poster     = posters[0] || '';
            var synopsis   = descriptions[0] ? descriptions[0].trim() : '';
            var isOngoing  = /ongoing/i.test(html);

            var episodeItems = [];
            
            var epRegex = /<a[^>]+wire:key="e-(\d+)"[^>]+href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+\/(\d+))"[^>]*>[\s\S]*?<div[^>]+min-w-10[^>]*>[\s\S]*?<\/div>[\s\S]*?<div[^>]+grow[^>]*>([^<]*)<\/div>/gi;
            var match;
            while ((match = epRegex.exec(html)) !== null) {
                var epNum   = parseInt(match[1], 10);
                var epUrl   = match[2];
                var epName  = match[4] ? match[4].trim() : ('Episode ' + match[3]);
                if (!epName || epName === 'Untitled') epName = 'Episode ' + match[3];

                episodeItems.push(new Episode({
                    name:      epName,
                    url:       epUrl,
                    season:    1,
                    episode:   epNum,
                    dubStatus: 'subbed',
                    posterUrl: poster,
                    runtime:   0
                }));
            }

            if (episodeItems.length === 0) {
                var epUrlRegex = /href="(https?:\/\/anizone\.to\/anime\/[a-z0-9]+\/(\d+))"/gi;
                var seen = {};
                while ((match = epUrlRegex.exec(html)) !== null) {
                    var epUrl  = match[1];
                    var epNum  = parseInt(match[2], 10);
                    if (seen[epUrl]) continue;
                    seen[epUrl] = true;
                    episodeItems.push(new Episode({
                        name:      'Episode ' + epNum,
                        url:       epUrl,
                        season:    1,
                        episode:   epNum,
                        dubStatus: 'subbed',
                        posterUrl: poster,
                        runtime:   0
                    }));
                }
            }

            episodeItems.sort(function(a, b) { return a.episode - b.episode; });

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       animeTitle,
                    url:         url,
                    posterUrl:   poster,
                    type:        'anime',
                    status:      isOngoing ? 'ongoing' : 'completed',
                    description: synopsis,
                    episodes:    episodeItems
                })
            });

        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // Load Streams
    async function loadStreams(url, cb) {
        try {
            var html = getBody(await http_get(url, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Gagal memuat HTML episode.' });

            var streamUrls = await parseHtml(html, 'media-player[src]', 'src');
            var m3u8Url = streamUrls[0];
            if (!m3u8Url) return cb({ success: false, error: 'Stream tidak ditemukan.' });

            var subSrcs   = await parseHtml(html, 'track[kind="subtitles"]', 'src');
            var subLabels = await parseHtml(html, 'track[kind="subtitles"]', 'label');
            var subLangs  = await parseHtml(html, 'track[kind="subtitles"]', 'srclang');

            var subtitles = [];
            for (var i = 0; i < subSrcs.length; i++) {
                if (!subSrcs[i]) continue;
                subtitles.push({
                    url:   subSrcs[i],
                    label: subLabels[i] || ('Sub ' + i),
                    lang:  subLangs[i]  || 'und'
                });
            }

            var stream = new StreamResult({
                url:       m3u8Url,
                quality:   'Multi Quality',
                headers:   { 'Referer': manifest.baseUrl + '/' },
                subtitles: subtitles
            });

            cb({ success: true, data: [stream] });

        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ─── Expose to Global Scope ───────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();