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

    function fixUrl(url) {
        if (!url) return null;
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('/')) return manifest.baseUrl + url;
        return url;
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

    // ── Individual resolvers ──

    async function resolveFiledon(embedUrl) {
        try {
            var slug = embedUrl.split('/embed/').pop().split(/[/?]/)[0];
            if (!slug) return null;
            var res = await http_get('https://filedon.co/embed/' + slug, {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Referer': manifest.baseUrl + '/'
            });
            var m = res.body.match(/id="app"\s+data-page="([^"]+)"/);
            if (!m) return null;
            var json = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
            return json?.props?.url || json?.url || null;
        } catch (_) { return null; }
    }

    async function resolvePixelDrain(url) {
        var m = url.match(/pixeldrain\.com\/(?:u|l)\/([a-zA-Z0-9]+)/);
        return m ? 'https://pixeldrain.com/api/file/' + m[1] + '?download' : null;
    }

    async function resolveWibufile(iframeUrl, label) {
        try {
            var res = await http_get(iframeUrl, {
                'Referer': manifest.baseUrl + '/',
                'User-Agent': BASE_HEADERS['User-Agent']
            });
            var m = res.body.match(/sources:\s*(\[.*?\])/s);
            if (!m) return null;
            var sources = JSON.parse(m[1].replace(/\\\//g, '/'));
            return sources.map(function(s) {
                return new StreamResult({
                    url: s.file,
                    quality: fixQuality(s.label || label),
                    source: label.trim(),
                    headers: { Referer: manifest.baseUrl + '/' }
                });
            });
        } catch (_) { return null; }
    }

    // ── Embed player (online streaming) ──

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

        var results = await Promise.all(buttons.map(async function(btn) {
            try {
                var ajax = await http_post(
                    manifest.baseUrl + '/wp-admin/admin-ajax.php', AJAX_HEADERS,
                    'action=player_ajax&post=' + btn.post + '&nume=' + encodeURIComponent(btn.nume) + '&type=' + encodeURIComponent(btn.type)
                );
                var embed = ajax.body;
                try { var p = typeof ajax.body === 'string' ? JSON.parse(ajax.body) : ajax.body; if (p.embed) embed = p.embed; } catch (_) {}
                var src = embed.match(/src=["']([^"']+)["']/i);
                return src ? resolveStream(src[1].replace(/&amp;/g, '&'), btn.label) : null;
            } catch (_) { return null; }
        }));

        var flat = [];
        results.forEach(function(r) {
            if (!r) return;
            Array.isArray(r) ? flat.push.apply(flat, r) : flat.push(r);
        });
        return flat;
    }

    // ── Download section ──

    var DL_RESOLVERS = [
        {
            name: 'PixelDrain',
            regex: /href="(https:\/\/pixeldrain\.com\/u\/[^"]+)"/i,
            resolve: resolvePixelDrain,
            headers: { Referer: 'https://pixeldrain.com/' }
        }
    ];

    async function resolveDownloadLinks(body) {
        var streams = [];
        var liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        var m;
        while ((m = liRegex.exec(body)) !== null) {
            var block = m[1];
            var qMatch = block.match(/<strong>([^<]+?)\s*<\/strong>/i);
            if (!qMatch) continue;
            var q = qMatch[1].trim();
            for (var r of DL_RESOLVERS) {
                try {
                    var match = block.match(r.regex);
                    if (!match) continue;
                    var url = await r.resolve(match[1]);
                    if (url) streams.push(new StreamResult({
                        url, quality: fixQuality(q),
                        source: r.name + ' ' + fixQuality(q),
                        headers: r.headers
                    }));
                } catch (e) {
                    console.error('Samehadaku: DL resolver ' + r.name + ' failed:', e);
                }
            }
        }
        return streams;
    }

    // ── AniList / AniZip ──

    async function getAniListData(title) {
        if (!title) return null;
        var query = 'query($s:String){Media(search:$s,type:ANIME){id idMal bannerImage nextAiringEpisode{episode timeUntilAiring}characters(sort:ROLE,perPage:15){edges{role node{name{full}image{large}}}}}}';
        try {
            var res = await http_post('https://graphql.anilist.co',
                { 'Content-Type': 'application/json', Accept: 'application/json' },
                JSON.stringify({ query: query, variables: { s: title } })
            );
            var data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
            var media = data?.data?.Media;
            if (!media) return null;
            return {
                id: String(media.id),
                idMal: media.idMal ? String(media.idMal) : null,
                characters: media.characters?.edges ?? [],
                nextAiring: media.nextAiringEpisode || null,
                bannerUrl: media.bannerImage || null,
            };
        } catch (_) { return null; }
    }

    async function getAniZipByMalId(malId) {
        if (!malId) return null;
        try {
            var res = await http_get('https://api.ani.zip/mappings?mal_id=' + malId,
                { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' });
            var data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
            return data?.episodes ? data : null;
        } catch (_) { return null; }
    }

    // ── getHome ──

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
                    var items = [];

                    if (cat.latest) {
                        var links   = await parse_html(res.body, 'div.thumb a', 'href');
                        var titles  = await parse_html(res.body, 'div.thumb a', 'title');
                        var posters = await parse_html(res.body, 'div.thumb img', 'src');
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
                        var links    = await parse_html(res.body, 'div.animposx > a', 'href');
                        var titles   = await parse_html(res.body, 'div.animposx .data .title h2', 'text');
                        var posters  = await parse_html(res.body, 'div.animposx img', 'src');
                        var statuses = await parse_html(res.body, 'div.animposx .data .type', 'text');
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

            var data = {};
            results.forEach(function (r) { if (r.list.length) data[r.key] = r.list; });
            if (!Object.keys(data).length) return cb({ success: false, error: 'Gagal memuat homepage.' });
            cb({ success: true, data: data });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ── search ──

    async function search(query, cb) {
        try {
            var res     = await http_get(manifest.baseUrl + '/?s=' + encodeURIComponent(query), BASE_HEADERS);
            var links   = await parse_html(res.body, 'div.animposx > a', 'href');
            var titles  = await parse_html(res.body, 'div.animposx .data .title h2', 'text');
            var posters = await parse_html(res.body, 'div.animposx img', 'src');
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
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ── load ──

    async function load(url, cb) {
        try {
            var res  = await http_get(url, BASE_HEADERS);
            var body = res.body;

            if (!url.includes('/anime/') || url.match(/episode/)) {
                var animeLinks = await parse_html(body, '.nvs.nvsc a', 'href');
                if (animeLinks[0]?.attr) {
                    url  = fixUrl(animeLinks[0].attr);
                    res  = await http_get(url, BASE_HEADERS);
                    body = res.body;
                }
            }

            var titleArr  = await parse_html(body, 'h1.entry-title', 'text');
            var animeTitle = (titleArr[0]?.text || 'Anime')
                .replace(/nonton|anime|subtitle\s+indonesia|sub\s+indo|lengkap|batch/gi, '').trim();

            var aniListPromise = getAniListData(animeTitle);

            var [
                posterArr, descArr, tagArr, trailerArr,
                epHrefs, epNums, recLinks, recTitles, recPosters,
                aniListData
            ] = await Promise.all([
                parse_html(body, 'div.thumb img', 'src'),
                parse_html(body, 'div.desc', 'text'),
                parse_html(body, 'div.genre-info a', 'text'),
                parse_html(body, 'div.trailer-anime iframe', 'src'),
                parse_html(body, '.epsleft .lchx a', 'href'),
                parse_html(body, '.epsright .eps a', 'text'),
                parse_html(body, 'div.rand-animesu a.series', 'href'),
                parse_html(body, 'div.rand-animesu .judul', 'text'),
                parse_html(body, 'div.rand-animesu img', 'src'),
                aniListPromise,
            ]);

            var aniZip = aniListData?.idMal ? await getAniZipByMalId(aniListData.idMal) : null;

            var statusMatch = body.match(/Status[^:]*:\s*<[^>]+>([^<]+)</i);
            var yearMatch   = body.match(/Rilis[^<]*<\/[^>]+>[\s\S]*?,\s*(\d{4})/i);
            var scoreMatch  = body.match(/itemprop="ratingValue"[^>]*>([^<]+)</i);

            var recommendations = recLinks.map(function(h, i) {
                if (!h?.attr || !recTitles[i]?.text) return null;
                return new MultimediaItem({ title: recTitles[i].text.trim(), url: fixUrl(h.attr), posterUrl: fixUrl(recPosters[i]?.attr || ''), type: 'anime' });
            }).filter(Boolean);

            var cast = (aniListData?.characters ?? []).map(function(edge) {
                var node = edge.node;
                if (!node) return null;
                return new Actor({ name: node.name?.full || 'Unknown', role: edge.role || 'SUPPORTING', image: node.image?.large || '' });
            }).filter(Boolean);

            var resolvedTitle = aniZip?.titles?.en || aniZip?.titles?.['x-jat'] || aniZip?.titles?.ja || animeTitle;
            var animePoster   = fixUrl(posterArr[0]?.attr || '');

            var episodes = epHrefs.map(function(href, i) {
                if (!href?.attr) return null;
                var epNum = parseInt(epNums[i]?.text) || (i + 1);
                var aniEp = aniZip?.episodes?.[String(epNum)] || null;
                return new Episode({
                    name:        aniEp?.title?.en || aniEp?.title?.['x-jat'] || ('Episode ' + epNum),
                    url:         fixUrl(href.attr),
                    season:      1,
                    episode:     epNum,
                    dubStatus:   'subbed',
                    posterUrl:   aniEp?.image || animePoster,
                    description: aniEp?.overview || '',
                    runtime:     aniEp?.runtime || undefined,
                    score:       aniEp?.score || undefined,
                    airDate:     aniEp?.airDateUtc ? aniEp.airDateUtc.substring(0, 10) : undefined
                });
            }).filter(Boolean).reverse();

            cb({
                success: true,
                data: new MultimediaItem({
                    title:           resolvedTitle,
                    url:             url,
                    posterUrl:       animePoster,
                    type:            'anime',
                    status:          getStatus(statusMatch ? statusMatch[1] : ''),
                    year:            yearMatch ? parseInt(yearMatch[1]) : undefined,
                    score:           scoreMatch ? parseFloat(scoreMatch[1]) || undefined : undefined,
                    description:     (descArr[0]?.text || '').replace(/\s+/g, ' ').trim(),
                    cast:            cast,
                    trailers:        trailerArr[0]?.attr ? [new Trailer({ url: trailerArr[0].attr })] : [],
                    tags:            tagArr.map(function(t) { return t?.text; }).filter(Boolean),
                    recommendations: recommendations,
                    episodes:        episodes,
                    syncData:        aniListData?.idMal ? { mal: aniListData.idMal, anilist: aniListData.id } : undefined,
                    bannerUrl: aniListData?.bannerUrl || undefined,
                    nextAiring: aniListData?.nextAiring ? new NextAiring({
                        episode:  aniListData.nextAiring.episode,
                        season:   1,
                        unixTime: Math.floor(Date.now() / 1000) + aniListData.nextAiring.timeUntilAiring
                    }) : undefined,
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ── loadStreams ──

    async function loadStreams(url, cb) {
        try {
            var res  = await http_get(url, BASE_HEADERS);
            var body = res.body;

            var [embedStreams, dlStreams] = await Promise.all([
                resolveEmbedButtons(body),
                resolveDownloadLinks(body)
            ]);

            var flat = [...(embedStreams || []), ...(dlStreams || [])];
            var Q = ['2160p', '1080p', '720p', '480p', '360p'];

            flat.sort(function(a, b) {
                var parse = function(src) {
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

            if (!flat.length) return cb({ success: false, error: 'Tidak ditemukan stream yang bisa diputar.' });
            cb({ success: true, data: flat });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();
