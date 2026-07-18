(function () {

    // ─── Constants ────────────────────────────────────────────────────────────
    var TMDB_API    = 'https://api.themoviedb.org/3';
    var TMDB_KEY    = '1865f43a0549ca50d341dd9ab8b29f49';
    var ANILIST_API = 'https://graphql.anilist.co';
    var ANI_ZIP     = 'https://api.ani.zip/mappings';
    var MEDIA_LIMIT = 20;

    var TRACKERS = [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://open.stealth.si:80/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://tracker.bittor.pw:1337/announce',
        'udp://public.popcorn-tracker.org:6969/announce',
        'udp://tracker.dler.org:6969/announce',
        'udp://exodus.desync.com:6969',
        'udp://open.demonii.com:1337/announce'
    ];

    var HTML_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
    };
    var JSON_HEADERS = {
        'Content-Type': 'application/json',
        'Accept':       'application/json'
    };

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    }

    function parseJSON(res) {
        try {
            var b = getBody(res);
            return typeof b === 'string' ? JSON.parse(b) : b;
        } catch (_) { return null; }
    }

    function imgUrl(path) {
        if (!path) return '';
        return path.startsWith('/') ? 'https://image.tmdb.org/t/p/original' + path : path;
    }

    async function anilistQuery(query, variables) {
        var res = await http_post(ANILIST_API, JSON_HEADERS, JSON.stringify({ query: query, variables: variables || {} }));
        return parseJSON(res);
    }

    function extractSeeders(title) {
        var m = (title || '').match(/👤\s*(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
    }

    function buildStreamLabel(title, name) {
        if (!title) return name || 'Torrentio';
        var tags     = (title.match(/(2160p|1080p|720p|480p|WEBRip|WEB-DL|BluRay|HDRip|DVDRip|x265|x264|XviD|DivX|10bit|HEVC|H264|HDR|DV|REMUX|PROPER)/gi) || [])
                       .map(function(t) { return t.toUpperCase(); })
                       .filter(function(t, i, a) { return a.indexOf(t) === i; })
                       .join(' | ');
        var seeder   = (title.match(/👤\s*(\d+)/) || [])[1];
        var size     = (title.match(/💾\s*([\d.]+ ?(?:GB|MB))/i) || [])[1];
        var provider = ((title.match(/⚙️\s*([^\n]+)/) || [])[1] || '').trim();
        var source   = (name || 'Torrentio').split('\n')[0].trim();
        var parts    = [source];
        if (tags)     parts.push(tags);
        if (size)     parts.push('💾 ' + size);
        if (seeder)   parts.push('👤 ' + seeder);
        if (provider) parts.push('⚙️ ' + provider);
        return parts.join(' | ');
    }

    function buildMagnet(hash, name) {
        var trackerParams = TRACKERS.map(function(t) { return '&tr=' + encodeURIComponent(t); }).join('');
        return 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name || hash) + trackerParams;
    }

    function getQuality(title) {
        return (title.match(/(2160p|1080p|720p|480p)/i) || [])[1] || 'Unknown';
    }

    function sortStreams(streams, seedersMap) {
        var qualityOrder = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
        return streams.slice().sort(function(a, b) {
            var sa = seedersMap[a.url] || 0;
            var sb = seedersMap[b.url] || 0;
            if (sa === 0 && sb > 0) return 1;
            if (sb === 0 && sa > 0) return -1;
            if (sb !== sa) return sb - sa;
            var qa = qualityOrder[(a.quality || '').toLowerCase()] || 0;
            var qb = qualityOrder[(b.quality || '').toLowerCase()] || 0;
            return qb - qa;
        });
    }

    function buildStreams(res) {
        var streams    = [];
        var seedersMap = {};
        res.streams.forEach(function(s) {
            var source   = buildStreamLabel(s.title || '', s.name || '');
            var quality  = getQuality(s.title || s.name || '');
            var seeders  = extractSeeders(s.title || '');
            var streamUrl;
            if (s.infoHash) {
                streamUrl = buildMagnet(s.infoHash, s.name);
            } else if (s.url) {
                streamUrl = s.url;
            } else {
                return;
            }
            streams.push(new StreamResult({
                url:     streamUrl,
                quality: quality,
                source:  source,
                headers: {}
            }));
            seedersMap[streamUrl] = seeders;
        });
        return { streams: streams, seedersMap: seedersMap };
    }

    var isAnimeProvider = manifest.baseUrl.indexOf('nyaasi') !== -1;

    // ─────────────────────────────────────────────────────────────────────────
    // TORRENTIO
    // ─────────────────────────────────────────────────────────────────────────

    async function torrentioGetHome(cb) {
        var categories = [
            { name: 'Trending',         url: TMDB_API + '/trending/all/day?api_key=' + TMDB_KEY + '&region=US' },
            { name: 'Popular Movies',   url: TMDB_API + '/trending/movie/week?api_key=' + TMDB_KEY + '&region=US&with_original_language=en' },
            { name: 'Popular TV Shows', url: TMDB_API + '/trending/tv/week?api_key=' + TMDB_KEY + '&region=US&with_original_language=en' },
            { name: 'Airing Today',     url: TMDB_API + '/tv/airing_today?api_key=' + TMDB_KEY + '&region=US&with_original_language=en' },
            { name: 'Netflix',          url: TMDB_API + '/discover/tv?api_key=' + TMDB_KEY + '&with_networks=213' },
            { name: 'Amazon',           url: TMDB_API + '/discover/tv?api_key=' + TMDB_KEY + '&with_networks=1024' },
            { name: 'Disney+',          url: TMDB_API + '/discover/tv?api_key=' + TMDB_KEY + '&with_networks=2739' },
            { name: 'Hulu',             url: TMDB_API + '/discover/tv?api_key=' + TMDB_KEY + '&with_networks=453' },
            { name: 'Apple TV+',        url: TMDB_API + '/discover/tv?api_key=' + TMDB_KEY + '&with_networks=2552' },
            { name: 'HBO',              url: TMDB_API + '/discover/tv?api_key=' + TMDB_KEY + '&with_networks=49' },
            { name: 'Top Rated Movies', url: TMDB_API + '/movie/top_rated?api_key=' + TMDB_KEY + '&region=US' },
            { name: 'Top Rated Shows',  url: TMDB_API + '/tv/top_rated?api_key=' + TMDB_KEY + '&region=US' },
            { name: 'Korean Shows',     url: TMDB_API + '/discover/tv?api_key=' + TMDB_KEY + '&with_original_language=ko' }
        ];
        try {
            var results = await Promise.all(categories.map(function(cat) {
                return http_get(cat.url, HTML_HEADERS).then(function(res) {
                    var json = parseJSON(res);
                    if (!json || !json.results) return { name: cat.name, items: [] };
                    var items = json.results.map(function(m) {
                        return new MultimediaItem({
                            title:          (m.title || m.name || 'Unknown').trim(),
                            url:            'tmdb:' + (m.media_type || (m.title ? 'movie' : 'tv')) + ':' + m.id,
                            posterUrl:      imgUrl(m.poster_path),
                            type:           m.media_type === 'movie' ? 'movie' : 'series',
                            score:          m.vote_average || undefined,
                            playbackPolicy: 'torrent'
                        });
                    });
                    return { name: cat.name, items: items };
                }).catch(function() {
                    return { name: cat.name, items: [] };
                });
            }));
            var result = {};
            results.forEach(function(r) {
                if (r.items.length) result[r.name] = r.items;
            });
            if (!Object.keys(result).length) return cb({ success: false, error: 'Gagal memuat homepage dari TMDB. Kemungkinan API key expired atau rate-limited.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioSearch(query, cb) {
        try {
            var json = parseJSON(await http_get(
                TMDB_API + '/search/multi?api_key=' + TMDB_KEY + '&language=en-US&query=' + encodeURIComponent(query) + '&page=1&include_adult=false',
                HTML_HEADERS
            ));
            var items = (json && json.results ? json.results : [])
                .filter(function(m) { return m.media_type === 'movie' || m.media_type === 'tv'; })
                .map(function(m) {
                    return new MultimediaItem({
                        title:          (m.title || m.name || 'Unknown').trim(),
                        url:            'tmdb:' + m.media_type + ':' + m.id,
                        posterUrl:      imgUrl(m.poster_path),
                        type:           m.media_type === 'movie' ? 'movie' : 'series',
                        score:          m.vote_average || undefined,
                        playbackPolicy: 'torrent'
                    });
                });
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioLoad(url, cb) {
        try {
            var parts    = url.split(':');
            var tmdbType = parts[1];
            var tmdbId   = parts[2];
            var isMovie  = tmdbType === 'movie';

            var res = parseJSON(await http_get(
                TMDB_API + '/' + tmdbType + '/' + tmdbId + '?api_key=' + TMDB_KEY + '&append_to_response=credits,external_ids,videos,recommendations,keywords',
                HTML_HEADERS
            ));
            if (!res) return cb({ success: false, error: 'Gagal memuat detail dari TMDB.' });

            var title    = res.title || res.name || 'Unknown';
            var poster   = imgUrl(res.poster_path);
            var banner   = imgUrl(res.backdrop_path);
            var overview = res.overview || '';
            var year     = parseInt((res.release_date || res.first_air_date || '').split('-')[0]) || undefined;
            var imdbId   = (res.external_ids && res.external_ids.imdb_id) || '';
            var score    = res.vote_average || undefined;
            var genres   = (res.genres || []).map(function(g) { return g.name; });
            var langs    = res.original_language;
            var isAnime  = genres.includes('Animation') && (langs === 'ja' || langs === 'zh');

            var cast = (res.credits && res.credits.cast ? res.credits.cast : []).slice(0, 15).map(function(c) {
                return new Actor({ name: c.name || 'Unknown', role: c.character || 'Supporting', image: imgUrl(c.profile_path) });
            });

            var trailers = [];
            if (res.videos && res.videos.results) {
                var tr = res.videos.results.find(function(v) { return v.type === 'Trailer'; });
                if (tr) trailers = [new Trailer({ url: 'https://www.youtube.com/watch?v=' + tr.key })];
            }

            var recommendations = (res.recommendations && res.recommendations.results ? res.recommendations.results : [])
                .slice(0, 10)
                .map(function(m) {
                    return new MultimediaItem({
                        title:     (m.title || m.name || 'Unknown').trim(),
                        url:       'tmdb:' + (m.title ? 'movie' : 'tv') + ':' + m.id,
                        posterUrl: imgUrl(m.poster_path),
                        type:      m.title ? 'movie' : 'series'
                    });
                });

            if (isMovie) {
                cb({
                    success: true,
                    data: new MultimediaItem({
                        title:          title,
                        url:            url,
                        posterUrl:      poster,
                        bannerUrl:      banner,
                        type:           'movie',
                        description:    overview,
                        year:           year,
                        score:          score,
                        cast:           cast,
                        trailers:       trailers,
                        recommendations: recommendations,
                        playbackPolicy: 'torrent',
                        episodes: [new Episode({
                            name:    title,
                            url:     JSON.stringify({ type: 'movie', imdbId: imdbId, title: title, year: year, isAnime: isAnime }),
                            season:  1,
                            episode: 1,
                            posterUrl: poster,
                            playbackPolicy: 'torrent'
                        })]
                    })
                });
            } else {
                var seasons = (res.seasons || []).filter(function(s) {
                    return s.season_number && s.season_number !== 0;
                });

                var seasonResults = await Promise.all(seasons.map(function(s) {
                    return http_get(
                        TMDB_API + '/tv/' + tmdbId + '/season/' + s.season_number + '?api_key=' + TMDB_KEY,
                        HTML_HEADERS
                    ).then(function(res) {
                        var seasonRes = parseJSON(res);
                        if (!seasonRes || !seasonRes.episodes) return [];
                        return seasonRes.episodes.map(function(ep) {
                            return new Episode({
                                name:           ep.name || ('Episode ' + ep.episode_number),
                                url:            JSON.stringify({ type: 'tv', imdbId: imdbId, title: title, year: year, season: ep.season_number, episode: ep.episode_number, isAnime: isAnime }),
                                season:         ep.season_number,
                                episode:        ep.episode_number,
                                posterUrl:      imgUrl(ep.still_path) || poster,
                                description:    ep.overview || '',
                                airDate:        ep.air_date || '',
                                runtime:        ep.runtime || undefined,
                                playbackPolicy: 'torrent'
                            });
                        });
                    }).catch(function() {
                        console.error('Torrentio: gagal memuat season ' + s.season_number + ' untuk ' + title);
                        return [];
                    });
                }));

                var episodes = [];
                seasonResults.forEach(function(epList) {
                    episodes = episodes.concat(epList);
                });

                cb({
                    success: true,
                    data: new MultimediaItem({
                        title:          title,
                        url:            url,
                        posterUrl:      poster,
                        bannerUrl:      banner,
                        type:           'series',
                        description:    overview,
                        year:           year,
                        score:          score,
                        cast:           cast,
                        trailers:       trailers,
                        recommendations: recommendations,
                        playbackPolicy: 'torrent',
                        episodes:       episodes
                    })
                });
            }
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioLoadStreams(url, cb) {
        try {
            var data    = JSON.parse(url);
            var imdbId  = data.imdbId;
            var isMovie = data.type === 'movie';

            if (!imdbId) return cb({ success: false, error: 'IMDB ID tidak tersedia. Torrentio membutuhkan IMDB ID untuk mencari stream.' });

            var endpoint = isMovie
                ? manifest.baseUrl + '/stream/movie/' + imdbId + '.json'
                : manifest.baseUrl + '/stream/series/' + imdbId + ':' + data.season + ':' + data.episode + '.json';

            var res = parseJSON(await http_get(endpoint, HTML_HEADERS));
            if (!res || !res.streams || !res.streams.length)
                return cb({ success: false, error: 'Tidak ada stream ditemukan di Torrentio untuk konten ini.' });

            var built = buildStreams(res);
            if (!built.streams.length) return cb({ success: false, error: 'Tidak ada stream tersedia.' });
            cb({ success: true, data: sortStreams(built.streams, built.seedersMap) });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TORRENTIO ANIME
    // ─────────────────────────────────────────────────────────────────────────

    function aniMediaToItem(m) {
        var title  = (m.title && (m.title.english || m.title.romaji)) || 'Unknown';
        var poster = (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large || m.coverImage.medium)) || '';
        return new MultimediaItem({
            title:          title,
            url:            'anilist:' + m.id,
            posterUrl:      poster,
            type:           'anime',
            score:          m.averageScore || undefined,
            playbackPolicy: 'torrent'
        });
    }

    async function torrentioAnimeGetHome(cb) {
        var sections = [
            { name: 'Trending',            query: 'query($p:Int=1){Page(page:$p,perPage:' + MEDIA_LIMIT + '){media(sort:[TRENDING_DESC,POPULARITY_DESC],isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}' },
            { name: 'Popular This Season', query: 'query($p:Int=1){Page(page:$p,perPage:' + MEDIA_LIMIT + '){media(sort:[TRENDING_DESC,POPULARITY_DESC],season:SPRING,isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}' },
            { name: 'All Time Popular',    query: 'query($p:Int=1){Page(page:$p,perPage:' + MEDIA_LIMIT + '){media(sort:[POPULARITY_DESC],isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}' },
            { name: 'Top 100 Anime',       query: 'query($p:Int=1){Page(page:$p,perPage:' + MEDIA_LIMIT + '){media(sort:[SCORE_DESC],isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}' }
        ];
        try {
            var results = await Promise.all(sections.map(function(sec) {
                return anilistQuery(sec.query).then(function(json) {
                    var media = json && json.data && json.data.Page && json.data.Page.media;
                    if (!media || !media.length) return { name: sec.name, items: [] };
                    return { name: sec.name, items: media.map(aniMediaToItem) };
                }).catch(function() {
                    return { name: sec.name, items: [] };
                });
            }));
            var result = {};
            results.forEach(function(r) {
                if (r.items.length) result[r.name] = r.items;
            });
            if (!Object.keys(result).length) return cb({ success: false, error: 'Gagal memuat homepage anime dari AniList.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioAnimeSearch(query, cb) {
        try {
            var q    = 'query($search:String){Page(page:1,perPage:' + MEDIA_LIMIT + '){media(search:$search,isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}';
            var json = await anilistQuery(q, { search: query });
            var media = json && json.data && json.data.Page && json.data.Page.media;
            cb({ success: true, data: (media || []).map(aniMediaToItem) });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioAnimeLoad(url, cb) {
        try {
            var anilistId = url.replace('anilist:', '');
            var q = 'query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english}startDate{year}genres description averageScore status bannerImage coverImage{extraLarge large medium}episodes format nextAiringEpisode{episode}airingSchedule{nodes{episode}}recommendations{edges{node{id mediaRecommendation{id title{romaji english}coverImage{extraLarge large medium}}}}}}}';
            var json = await anilistQuery(q, { id: parseInt(anilistId) });
            var data = json && json.data && json.data.Media;
            if (!data) return cb({ success: false, error: 'Gagal memuat detail anime dari AniList.' });

            var title       = (data.title && (data.title.english || data.title.romaji)) || 'Unknown';
            var poster      = (data.coverImage && (data.coverImage.extraLarge || data.coverImage.large)) || '';
            var banner      = data.bannerImage || '';
            var description = data.description || '';
            var year        = (data.startDate && data.startDate.year) || undefined;
            var isMovie     = (data.format || '').toLowerCase().includes('movie');
            var score       = data.averageScore || undefined;
            var status      = (data.status || '').toLowerCase().includes('releasing') ? 'ongoing' : 'completed';

            var totalEps = 0;
            if (data.nextAiringEpisode && data.nextAiringEpisode.episode) totalEps = data.nextAiringEpisode.episode - 1;
            else if (data.episodes) totalEps = data.episodes;
            else if (data.airingSchedule && data.airingSchedule.nodes && data.airingSchedule.nodes.length) totalEps = data.airingSchedule.nodes[0].episode || 0;

            var aniZipRes   = parseJSON(await http_get(ANI_ZIP + '?anilist_id=' + anilistId, HTML_HEADERS));
            var aniEpisodes = (aniZipRes && aniZipRes.episodes) || {};
            var aniTitles   = (aniZipRes && aniZipRes.titles) || {};
            var aniMappings = (aniZipRes && aniZipRes.mappings) || {};
            var kitsuId     = aniMappings.kitsu_id || null;

            var recommendations = [];
            if (data.recommendations && data.recommendations.edges) {
                recommendations = data.recommendations.edges.slice(0, 10).map(function(edge) {
                    var rec = edge.node && edge.node.mediaRecommendation;
                    if (!rec) return null;
                    return new MultimediaItem({
                        title:     (rec.title && (rec.title.english || rec.title.romaji)) || 'Unknown',
                        url:       'anilist:' + rec.id,
                        posterUrl: (rec.coverImage && (rec.coverImage.large || rec.coverImage.medium)) || '',
                        type:      'anime'
                    });
                }).filter(Boolean);
            }

            var episodes = [];
            if (isMovie) {
                episodes = [new Episode({
                    name:           title,
                    url:            JSON.stringify({ type: 'movie', anilistId: anilistId, kitsuId: kitsuId, title: title, year: year, episode: 1 }),
                    season:         1,
                    episode:        1,
                    posterUrl:      poster,
                    playbackPolicy: 'torrent'
                })];
            } else {
                for (var i = 1; i <= totalEps; i++) {
                    var epMeta  = aniEpisodes[String(i)] || null;
                    var epTitle = (epMeta && epMeta.title && (epMeta.title.en || epMeta.title['x-jat'] || epMeta.title.ja)) || aniTitles.en || ('Episode ' + i);
                    episodes.push(new Episode({
                        name:           epTitle,
                        url:            JSON.stringify({ type: 'series', anilistId: anilistId, kitsuId: kitsuId, title: title, year: year, episode: i }),
                        season:         1,
                        episode:        i,
                        posterUrl:      (epMeta && epMeta.image) || poster,
                        description:    (epMeta && epMeta.overview) || '',
                        airDate:        (epMeta && (epMeta.airDateUtc || epMeta.airdate)) || '',
                        runtime:        (epMeta && epMeta.runtime) || undefined,
                        dubStatus:      'subbed',
                        playbackPolicy: 'torrent'
                    }));
                }
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title:           aniTitles.en || title,
                    url:             url,
                    posterUrl:       poster,
                    bannerUrl:       banner,
                    type:            'anime',
                    description:     description,
                    year:            year,
                    score:           score,
                    status:          status,
                    recommendations: recommendations,
                    playbackPolicy:  'torrent',
                    episodes:        episodes
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioAnimeLoadStreams(url, cb) {
        try {
            var data    = JSON.parse(url);
            var kitsuId = data.kitsuId;
            var isMovie = data.type === 'movie';
            if (!kitsuId) return cb({ success: false, error: 'Kitsu ID tidak ditemukan. Anime ini tidak memiliki mapping ke Kitsu.' });

            var endpoint = isMovie
                ? manifest.baseUrl + '/stream/movie/kitsu:' + kitsuId + '.json'
                : manifest.baseUrl + '/stream/series/kitsu:' + kitsuId + ':' + (data.episode || 1) + '.json';

            var res = parseJSON(await http_get(endpoint, HTML_HEADERS));
            if (!res || !res.streams || !res.streams.length)
                return cb({ success: false, error: 'Tidak ada stream ditemukan di Torrentio untuk anime ini.' });

            var built = buildStreams(res);
            if (!built.streams.length) return cb({ success: false, error: 'Tidak ada stream tersedia.' });
            cb({ success: true, data: sortStreams(built.streams, built.seedersMap) });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Router ───────────────────────────────────────────────────────────────
    async function getHome(cb) {
        return isAnimeProvider ? torrentioAnimeGetHome(cb) : torrentioGetHome(cb);
    }

    async function search(query, cb) {
        return isAnimeProvider ? torrentioAnimeSearch(query, cb) : torrentioSearch(query, cb);
    }

    async function load(url, cb) {
        return isAnimeProvider ? torrentioAnimeLoad(url, cb) : torrentioLoad(url, cb);
    }

    async function loadStreams(url, cb) {
        return isAnimeProvider ? torrentioAnimeLoadStreams(url, cb) : torrentioLoadStreams(url, cb);
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams  = loadStreams;

})();
