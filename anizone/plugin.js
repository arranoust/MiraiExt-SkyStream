(function () {

    // ─── Config ───────────────────────────────────────────────────────────────
    var manifest = { baseUrl: 'https://anizone.to' };

    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    var HTML_HEADERS = {
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

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
                return item.attr || item[attr] || '';
            });
        } catch (_) { return []; }
    }

    // ─── AniList ──────────────────────────────────────────────────────────────
    async function getAniListData(title) {
        if (!title) return null;
        var query = 'query($s:String){Media(search:$s,type:ANIME){idMal characters(sort:ROLE,perPage:15){edges{role node{name{full native}image{large medium}}}}}}';
        try {
            var res   = await http_post('https://graphql.anilist.co',
                { 'Content-Type': 'application/json', Accept: 'application/json' },
                JSON.stringify({ query: query, variables: { s: title } })
            );
            var data  = typeof res?.body === 'string' ? JSON.parse(res.body) : res?.body;
            var media = data?.data?.Media;
            if (!media) return null;
            return { idMal: media.idMal ? String(media.idMal) : null, characters: media.characters?.edges ?? [] };
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

    async function fetchMetadata(titles) {
        var valid = (titles || []).filter(Boolean);
        if (!valid.length) return { aniListData: null, aniZip: null };
        var aniListData = null;
        for (var i = 0; i < valid.length; i++) {
            aniListData = await getAniListData(valid[i]);
            if (aniListData?.idMal) break;
        }
        var aniZip = aniListData?.idMal ? await getAniZipByMalId(aniListData.idMal) : null;
        return { aniListData, aniZip };
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var base = manifest.baseUrl;
            var html = getBody(await http_get(base, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load HTML.' });

            // Latest Episodes — use parse_html on episode list items
            var epUrls    = await parseHtml(html, 'li[x-data] a[href*="/anime/"]', 'href');
            var epThumbs  = await parseHtml(html, 'li[x-data] img[src*="snapshot"]', 'src');
            var epTitles  = await parseHtml(html, 'li[x-data] a[title]', 'title');

            var latestEpisodes = [];
            var seenEpUrls    = {};
            for (var i = 0; i < epUrls.length; i++) {
                var epUrl = epUrls[i];
                if (!epUrl || seenEpUrls[epUrl]) continue;
                // Only episode URLs (has numeric segment at end)
                if (!/\/anime\/[a-z0-9]+\/\d+$/i.test(epUrl)) continue;
                seenEpUrls[epUrl] = true;

                var animeUrl = epUrl.replace(/\/\d+$/, '');
                latestEpisodes.push(new MultimediaItem({
                    title:     epTitles[i] || 'Episode',
                    url:       epUrl,
                    posterUrl: epThumbs[i] || '',
                    bannerUrl: epThumbs[i] || '',
                    type:      'anime'
                }));
            }

            // Latest Anime (swiper)
            var links   = await parseHtml(html, '.swiper-wrapper .swiper-slide .line-clamp-2 a', 'href');
            var titles  = await parseHtml(html, '.swiper-wrapper .swiper-slide .line-clamp-2 a', 'text');
            var posters = await parseHtml(html, '.swiper-wrapper .swiper-slide img', 'src');

            var latestAnime = [];
            for (var j = 0; j < Math.min(links.length, titles.length); j++) {
                var href = links[j];
                if (!href) continue;
                latestAnime.push(new MultimediaItem({
                    title:     (titles[j] || 'No Title').trim(),
                    url:       href.startsWith('http') ? href : base + href,
                    posterUrl: posters[j] || '',
                    type:      'anime'
                }));
            }

            var result = {};
            if (latestEpisodes.length) result['Latest Episodes'] = latestEpisodes;
            if (latestAnime.length)    result['Latest Anime']    = latestAnime;

            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var base = manifest.baseUrl;
            var html = getBody(await http_get(base + '/anime?search=' + encodeURIComponent(query), HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load search HTML.' });

            var titles  = await parseHtml(html, '.grid a[href*="/anime/"]', 'text');
            var urls    = await parseHtml(html, '.grid a[href*="/anime/"]', 'href');
            var posters = await parseHtml(html, '.grid img', 'src');

            var results = [];
            for (var i = 0; i < Math.min(titles.length, urls.length); i++) {
                var href = urls[i];
                if (!href) continue;
                if (/\/anime\/[a-z0-9]+\/\d+$/i.test(href)) continue; // skip episode URLs
                results.push(new MultimediaItem({
                    title:     (titles[i] || 'No Title').trim(),
                    url:       href.startsWith('http') ? href : base + href,
                    posterUrl: posters[i] || '',
                    type:      'anime'
                }));
            }

            cb({ success: true, data: results });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            // Normalize to anime page URL (strip episode number)
            var animeUrl = url.replace(/\/anime\/([a-z0-9]+)\/\d+$/i, '/anime/$1');

            var html = getBody(await http_get(animeUrl, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load anime detail HTML.' });

            var titleArr  = await parseHtml(html, 'h1', 'text');
            var posterArr = await parseHtml(html, 'img[src*="/images/anime/"]', 'src');
            var descArr   = await parseHtml(html, '.text-slate-100.text-center div', 'text');

            var animeTitle = (titleArr[0] || '').trim() || 'No Title';
            var poster     = posterArr[0] || '';
            var synopsis   = (descArr[0] || '').trim() || 'No description available.';
            var isOngoing  = /ongoing/i.test(html);

            // Fetch metadata in parallel with page parse
            var { aniListData, aniZip } = await fetchMetadata([animeTitle]);

            var cast = (aniListData?.characters ?? []).map(function (edge) {
                var node = edge.node;
                if (!node) return null;
                return new Actor({
                    name:  node.name?.full || node.name?.native || 'Unknown',
                    role:  edge.role || 'SUPPORTING',
                    image: node.image?.large || node.image?.medium || ''
                });
            }).filter(Boolean);

            var resolvedTitle = aniZip?.titles?.en || aniZip?.titles?.['x-jat'] || aniZip?.titles?.ja || animeTitle;

            // Episodes — use parse_html selectors instead of regex
            var epHrefs  = await parseHtml(html, 'li[x-data] a[href*="/anime/"]', 'href');
            var epThumbsRaw = await parseHtml(html, 'li[x-data] img', 'src');
            var epH3s    = await parseHtml(html, 'li[x-data] h3', 'text');
            var epDates  = await parseHtml(html, 'li[x-data] [datetime]', 'datetime');

            var episodeItems = [];
            var seenUrls     = {};

            for (var i = 0; i < epHrefs.length; i++) {
                var epUrl = epHrefs[i];
                if (!epUrl || seenUrls[epUrl]) continue;
                var numMatch = epUrl.match(/\/(\d+)$/);
                if (!numMatch) continue;
                seenUrls[epUrl] = true;

                var epNum  = parseInt(numMatch[1], 10);
                var aniEp  = aniZip?.episodes?.[String(epNum)] || null;
                var epName = aniEp?.title?.en || aniEp?.title?.['x-jat'] || aniEp?.title?.ja
                          || (epH3s[i] || '').trim() || ('Episode ' + epNum);

                episodeItems.push(new Episode({
                    name:        epName,
                    url:         epUrl,
                    season:      1,
                    episode:     epNum,
                    dubStatus:   'subbed',
                    posterUrl:   aniEp?.image || epThumbsRaw[i] || poster,
                    airDate:     epDates[i] || (aniEp?.airDateUtc || '').slice(0, 10) || '',
                    description: aniEp?.overview ? String(aniEp.overview) : '',
                    runtime:     aniEp?.runtime ? Math.round(aniEp.runtime) : undefined
                }));
            }

            episodeItems.sort(function (a, b) { return a.episode - b.episode; });

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       resolvedTitle,
                    url:         animeUrl,
                    posterUrl:   poster,
                    type:        'anime',
                    status:      isOngoing ? 'ongoing' : 'completed',
                    description: synopsis,
                    cast:        cast,
                    episodes:    episodeItems
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var html = getBody(await http_get(url, HTML_HEADERS));
            if (!html) return cb({ success: false, error: 'Failed to load episode HTML.' });

            var streamUrls = await parseHtml(html, 'media-player[src]', 'src');
            var m3u8Url    = streamUrls[0];
            if (!m3u8Url) return cb({ success: false, error: 'Stream not found.' });

            var subSrcs   = await parseHtml(html, 'track[kind="subtitles"]', 'src');
            var subLabels = await parseHtml(html, 'track[kind="subtitles"]', 'label');
            var subLangs  = await parseHtml(html, 'track[kind="subtitles"]', 'srclang');

            var subtitles = subSrcs.map(function (src, i) {
                if (!src) return null;
                return { url: src, label: subLabels[i] || ('Sub ' + i), lang: subLangs[i] || 'und' };
            }).filter(Boolean);

            cb({
                success: true,
                data: [new StreamResult({
                    url:       m3u8Url,
                    quality:   'Multi Quality',
                    headers:   { Referer: manifest.baseUrl + '/' },
                    subtitles: subtitles
                })]
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams  = loadStreams;

})();