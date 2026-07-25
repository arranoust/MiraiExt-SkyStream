(function () {

    var CDN = 'https://cdn.4animo.xyz';
    var SITE = 'https://4animo.xyz';

    var BASE_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': SITE + '/'
    };

    var AJAX_HEADERS = {
        'User-Agent': BASE_HEADERS['User-Agent'],
        'Accept': 'application/json, text/plain, */*',
        'Referer': SITE + '/'
    };

    var M3U8_HEADERS = {
        'User-Agent': BASE_HEADERS['User-Agent'],
        'Referer': SITE + '/'
    };

    function fixUrl(url) {
        if (!url) return null;
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('/')) return manifest.baseUrl + url;
        return url;
    }

    function resolveUrl(base, relative) {
        if (!relative) return base;
        if (relative.indexOf('http') === 0) return relative;
        var b = base.substring(0, base.lastIndexOf('/') + 1);
        if (relative.startsWith('/')) return base.split('/').slice(0, 3).join('/') + relative;
        return b + relative;
    }

    function getStatus(status) {
        var s = (status || '').toUpperCase();
        if (s === 'RELEASING' || s === 'ONGOING') return 'ongoing';
        if (s === 'FINISHED' || s === 'COMPLETED') return 'completed';
        return 'ongoing';
    }

    function getPosterUrl(id) {
        return 'https://cdnanimo.xyz/poster/' + id + '.jpg';
    }

    function mapAnimeItem(item) {
        var title = item.titles?.english || item.titles?.romaji || item.name || item.title || 'Unknown';
        var poster = item.images?.poster || getPosterUrl(item.id);
        return new MultimediaItem({
            title: title,
            url: manifest.baseUrl + '/' + item.slug,
            posterUrl: poster,
            type: (item.type || 'TV').toLowerCase(),
            status: getStatus(item.status),
            year: item.aired && item.aired !== 'N/A' ? parseInt(item.aired) : (item.season_year || undefined),
            score: item.score || undefined
        });
    }

    function extractIdFromSlug(slug) {
        var m = slug.match(/-(\d+)$/);
        return m ? parseInt(m[1]) : null;
    }

    function extractIdFromUrl(url) {
        var slugMatch = url.match(/\/([^\/\?]+)$/);
        if (!slugMatch) return null;
        return extractIdFromSlug(slugMatch[1]);
    }

    function parseHlsVariants(content, baseUrl) {
        if (!content || content.indexOf('#EXTM3U') === -1) return null;
        var variants = [], lines = content.split('\n'), inf = null, hasStreamInf = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
                hasStreamInf = true;
                var resM = line.match(/RESOLUTION=(\d+)x(\d+)/);
                var bwM  = line.match(/[^-]BANDWIDTH=(\d+)\b/);
                inf = { height: resM ? parseInt(resM[2], 10) : 0, bandwidth: bwM ? parseInt(bwM[1], 10) : 0 };
            } else if (line.indexOf('#') === 0) {
                continue;
            } else if (inf) {
                var vUrl = resolveUrl(baseUrl, line);
                var h = inf.height;
                var label = h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p'
                          : h >= 480 ? '480p' : h >= 360 ? '360p' : (h ? h + 'p' : 'Auto');
                variants.push({ url: vUrl, height: h, bandwidth: inf.bandwidth, label: label });
                inf = null;
            }
        }
        variants.sort(function (a, b) { return b.height - a.height; });
        return variants.length > 0 && hasStreamInf ? variants : null;
    }

    // ── getHome ──

    async function getHome(cb) {
        try {
            var urls = [
                manifest.baseUrl + '/ajax/home',
                manifest.baseUrl + '/ajax/filter?status=RELEASING&page=1&limit=24',
                manifest.baseUrl + '/ajax/filter?status=FINISHED&page=1&limit=24',
                manifest.baseUrl + '/ajax/filter?type=MOVIE&page=1&limit=24'
            ];

            var results = await http_parallel(urls.map(function (u) {
                return { url: u, headers: AJAX_HEADERS };
            }));

            var homeData = typeof results[0].body === 'string' ? JSON.parse(results[0].body) : results[0].body;
            var ongoingData = typeof results[1].body === 'string' ? JSON.parse(results[1].body) : results[1].body;
            var completedData = typeof results[2].body === 'string' ? JSON.parse(results[2].body) : results[2].body;
            var moviesData = typeof results[3].body === 'string' ? JSON.parse(results[3].body) : results[3].body;

            var data = {};

            if (homeData?.data?.mostPopular?.length) {
                data['Popular'] = homeData.data.mostPopular.map(mapAnimeItem);
            }

            if (ongoingData?.data?.length) {
                data['Ongoing'] = ongoingData.data.map(mapAnimeItem);
            }

            if (completedData?.data?.length) {
                data['Completed'] = completedData.data.map(mapAnimeItem);
            }

            if (moviesData?.data?.length) {
                data['Movies'] = moviesData.data.map(mapAnimeItem);
            }

            if (!Object.keys(data).length) {
                return cb({ success: false, error: 'No data found.' });
            }

            cb({ success: true, data: data });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ── search ──

    async function search(query, cb) {
        try {
            var res = await http_get(
                manifest.baseUrl + '/ajax/search?keyword=' + encodeURIComponent(query) + '&page=1&limit=24',
                AJAX_HEADERS
            );
            var data = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;

            if (!data?.response?.length) {
                return cb({ success: false, error: 'No results found.' });
            }

            var items = data.response.map(function (item) {
                return new MultimediaItem({
                    title: item.title || item.name || item.titles?.english || 'Unknown',
                    url: manifest.baseUrl + '/' + item.slug,
                    posterUrl: item.images?.poster || getPosterUrl(item.id),
                    type: (item.type || 'TV').toLowerCase(),
                    status: getStatus(item.status),
                    year: item.aired && item.aired !== 'N/A' ? parseInt(item.aired) : undefined,
                    episodes: item.episodes_count || undefined
                });
            });

            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ── load ──

    async function load(url, cb) {
        try {
            var animeId = extractIdFromUrl(url);
            if (!animeId) {
                return cb({ success: false, error: 'Could not extract anime ID from URL.' });
            }

            var animeRes = await http_get(manifest.baseUrl + '/ajax/anime/' + animeId, AJAX_HEADERS);
            var anime = typeof animeRes.body === 'string' ? JSON.parse(animeRes.body) : animeRes.body;

            if (anime?.error) {
                return cb({ success: false, error: anime.error });
            }

            var epsRes = await http_get(manifest.baseUrl + '/ajax/anime/' + animeId + '/episodes', AJAX_HEADERS);
            var epsData = typeof epsRes.body === 'string' ? JSON.parse(epsRes.body) : epsRes.body;
            var episodes = epsData?.data || [];

            var title = anime.titles?.english || anime.titles?.romaji || anime.titles?.native || 'Unknown';
            var poster = anime.images?.poster || getPosterUrl(animeId);
            var banner = anime.images?.banner || '';
            var status = getStatus(anime.status);
            var synopsis = (anime.synopsis || '').replace(/<[^>]+>/g, '').trim();

            var tags = (anime.tags || []).map(function (t) { return typeof t === 'string' ? t : t.name; });

            var hasSub = false, hasDub = false;
            for (var i = 0; i < episodes.length; i++) {
                if (episodes[i].sub) hasSub = true;
                if (episodes[i].dub) hasDub = true;
                if (hasSub && hasDub) break;
            }
            if (!hasSub && !hasDub) hasSub = true;

            function buildEpisodes(dubStatus, typeParam) {
                var suffix = typeParam ? '?type=' + typeParam : '';
                return episodes.map(function (ep) {
                    var epTitle = ep.titles?.en || ep.titles?.romaji || ('Episode ' + ep.number);
                    var epUrl = manifest.baseUrl + '/watch/' + anime.slug + '?ep=' + ep.number + suffix;

                    return new Episode({
                        name: epTitle,
                        url: epUrl,
                        season: 1,
                        episode: ep.number,
                        dubStatus: dubStatus,
                        posterUrl: ep.thumbnail || '',
                        rating: ep.rating ? parseFloat(ep.rating) : undefined
                    });
                });
            }

            var episodeList = [];
            if (hasDub) {
                episodeList = episodeList.concat(buildEpisodes('subbed', 'sub'));
                episodeList = episodeList.concat(buildEpisodes('dubbed', 'dub'));
            } else {
                episodeList = buildEpisodes('subbed');
            }

            var recommendations = [];
            if (Array.isArray(anime.recommendations)) {
                recommendations = anime.recommendations.slice(0, 12).map(function (rec) {
                    if (!rec) return null;
                    var rSlug = rec.slug || '';
                    var rTitle = rec.titles?.english || rec.titles?.romaji || rec.title || '';
                    var rPoster = rec.images?.poster || (rec.id ? getPosterUrl(rec.id) : '');
                    return new MultimediaItem({
                        title: rTitle,
                        url: manifest.baseUrl + '/' + rSlug,
                        posterUrl: rPoster,
                        type: 'anime'
                    });
                }).filter(Boolean);
            }

            var nextAiring = null;
            if (anime.next_airing_episode) {
                nextAiring = new NextAiring({
                    episode: anime.next_airing_episode.episode,
                    season: 1,
                    unixTime: anime.next_airing_episode.airingAt || Math.floor(Date.now() / 1000)
                });
            }

            var malId = anime.mal_id ? String(anime.mal_id) : null;
            var alId = anime.al_id ? String(anime.al_id) : null;

            cb({
                success: true,
                data: new MultimediaItem({
                    title: title,
                    url: url,
                    posterUrl: poster,
                    bannerUrl: banner || undefined,
                    type: 'anime',
                    status: status,
                    description: synopsis,
                    year: anime.season?.year || anime.air?.start ? parseInt(anime.air.start.substring(0, 4)) : undefined,
                    score: anime.score || undefined,
                    tags: tags,
                    episodes: episodeList,
                    recommendations: recommendations,
                    nextAiring: nextAiring,
                    syncData: (malId || alId) ? { mal: malId, anilist: alId } : undefined
                })
            });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    // ── loadStreams ──

    async function loadStreams(url, cb) {
        try {
            var typeMatch = url.match(/[?&]type=(sub|dub)/i);
            var typeFilter = typeMatch ? typeMatch[1].toLowerCase() : null;

            var servers = [
                { name: 'HD-1', path: 'a' },
                { name: 'HD-2', path: 's-1' },
                { name: 'HD-3', path: 'hd-1' },
                { name: 'HD-4', path: 'hd-2' }
            ];

            var audioTypes = typeFilter ? [typeFilter] : ['sub', 'dub'];

            var episodeData = await extractEpisodeData(url);
            if (!episodeData) {
                return cb({ success: false, error: 'Could not extract episode data.' });
            }

            var streams = [];

            for (var ai = 0; ai < audioTypes.length; ai++) {
                var audioType = audioTypes[ai];
                var audioLabel = audioType === 'sub' ? 'Sub' : 'Dub';

                for (var si = 0; si < servers.length; si++) {
                    var server = servers[si];
                    var embedUrl = constructEmbedUrl(episodeData, server, audioType);

                    if (!embedUrl) continue;

                    try {
                        var results = await resolveM3u8(embedUrl, server.name, audioLabel);
                        if (results) {
                            for (var r = 0; r < results.length; r++) streams.push(results[r]);
                        }
                    } catch (_) {}
                }
            }

            if (!streams.length) {
                return cb({ success: false, error: 'No playable streams found.' });
            }

            cb({ success: true, data: streams });
        } catch (e) {
            cb({ success: false, error: String(e) });
        }
    }

    async function extractEpisodeData(url) {
        var slugMatch = url.match(/\/watch\/([^?]+)/);
        var epMatch = url.match(/[?&]ep=(\d+)/);

        if (!slugMatch || !epMatch) return null;

        var slug = slugMatch[1];
        var epNumber = parseInt(epMatch[1]);

        var animeId = extractIdFromSlug(slug);
        if (!animeId) return null;

        var epsRes = await http_get(manifest.baseUrl + '/ajax/anime/' + animeId + '/episodes', AJAX_HEADERS);
        var epsData = typeof epsRes.body === 'string' ? JSON.parse(epsRes.body) : epsRes.body;
        var episodes = epsData?.data || [];

        var currentEp = null;
        for (var i = 0; i < episodes.length; i++) {
            if (episodes[i].number === epNumber) {
                currentEp = episodes[i];
                break;
            }
        }

        if (!currentEp) return null;

        return {
            animeId: animeId,
            slug: slug,
            episode: currentEp,
            epNumber: epNumber
        };
    }

    function constructEmbedUrl(data, server, audioType) {
        var ep = data.episode;

        if (server.path === 'a') {
            return CDN + '/embed/a-1/' + ep.id + '/' + audioType + '?k=1&autoPlay=1&skipIntro=1&skipOutro=1';
        }

        if (server.path === 's-1') {
            if (!ep.embed_id) return null;
            return CDN + '/embed/s-1/' + ep.embed_id + '/' + audioType + '?k=1&autoPlay=1&skipIntro=1&skipOutro=1';
        }

        if (server.path === 'hd-1') {
            if (!ep.ani) return null;
            return CDN + '/embed/hd-1/ani/' + ep.ani + '/' + audioType + '?k=1&autoPlay=1&skipIntro=1&skipOutro=1';
        }

        if (server.path === 'hd-2') {
            if (!ep.ani) return null;
            return CDN + '/embed/hd-2/ani/' + ep.ani + '/' + audioType + '?k=1&autoPlay=1&skipIntro=1&skipOutro=1';
        }

        return null;
    }

    async function resolveM3u8(embedUrl, serverName, audioLabel) {
        var res = await http_get(embedUrl, AJAX_HEADERS);
        var body = res.body;

        var sourcesMatch = body.match(/var\s+sourcesUrl\s*=\s*['"]([^'"]+)['"]/);
        if (!sourcesMatch) return null;

        var sourcesUrl = CDN + sourcesMatch[1];

        var sourcesRes = await http_get(sourcesUrl, AJAX_HEADERS);
        var sourcesData = typeof sourcesRes.body === 'string' ? JSON.parse(sourcesRes.body) : sourcesRes.body;

        var m3u8 = null;
        if (sourcesData?.sources?.[0]?.file) {
            m3u8 = sourcesData.sources[0].file;
        } else if (sourcesData?.link?.file) {
            m3u8 = sourcesData.link.file;
        } else if (sourcesData?.file) {
            m3u8 = sourcesData.file;
        }

        if (!m3u8) return null;

        if (m3u8.startsWith('/')) m3u8 = CDN + m3u8;

        var subtitles = [];
        if (sourcesData?.tracks?.length) {
            for (var i = 0; i < sourcesData.tracks.length; i++) {
                var track = sourcesData.tracks[i];
                if (track.kind === 'captions' || track.kind === 'subtitles') {
                    var tUrl = track.file;
                    if (tUrl && tUrl.startsWith('/')) tUrl = CDN + tUrl;
                    subtitles.push({
                        url: tUrl,
                        label: track.label || 'English',
                        lang: (track.label || 'en').toLowerCase().substring(0, 2)
                    });
                }
            }
        }

        var m3u8Res = await http_get(m3u8, M3U8_HEADERS);
        var m3u8Body = m3u8Res.body;
        var variants = parseHlsVariants(m3u8Body, m3u8);

        var results = [];

        if (variants && variants.length > 1) {
            for (var v = 0; v < variants.length; v++) {
                var sv = variants[v];
                results.push(new StreamResult({
                    url: sv.url,
                    quality: sv.label,
                    source: serverName + ' | ' + sv.label + ' (' + audioLabel + ')',
                    headers: { Referer: SITE + '/' },
                    subtitles: v === 0 && subtitles.length ? subtitles : undefined
                }));
            }
        } else {
            var quality = variants && variants[0] ? variants[0].label : 'Auto';
            results.push(new StreamResult({
                url: m3u8,
                quality: quality,
                source: serverName + ' (' + audioLabel + ')',
                headers: { Referer: SITE + '/' },
                subtitles: subtitles.length ? subtitles : undefined
            }));
        }

        return results.length ? results : null;
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

}());
