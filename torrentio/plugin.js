(function () {

    // ─── Config ───────────────────────────────────────────────────────────────
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
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    };
    var JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

    // ─── Provider detection ───────────────────────────────────────────────────
    // Relies on manifest.providerId injected per provider (Option A, plugin.json).
    // "Torrentio" → movies/series, "TorrentioAnime" → anime via nyaasi.
    var isAnimeProvider = manifest.providerId === 'TorrentioAnime';

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    }

    function parseJSON(res) {
        try { var b = getBody(res); return typeof b === 'string' ? JSON.parse(b) : b; }
        catch (_) { return null; }
    }

    function imgUrl(path) {
        if (!path) return '';
        return path.startsWith('/') ? 'https://image.tmdb.org/t/p/original' + path : path;
    }

    async function anilistQuery(query, variables) {
        var res = await http_post(ANILIST_API, JSON_HEADERS, JSON.stringify({ query: query, variables: variables || {} }));
        return parseJSON(res);
    }

    function buildStreamLabel(title, name) {
        if (!title) return name || 'Torrentio';
        var tags     = (title.match(/(2160p|1080p|720p|480p|WEBRip|WEB-DL|BluRay|HDRip|DVDRip|x265|x264|XviD|DivX|10bit|HEVC|H264|HDR|DV|REMUX|PROPER)/gi) || [])
                       .map(function (t) { return t.toUpperCase(); })
                       .filter(function (t, i, a) { return a.indexOf(t) === i; })
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
        var tr = TRACKERS.map(function (t) { return '&tr=' + encodeURIComponent(t); }).join('');
        return 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name || hash) + tr;
    }

    function getQuality(title) {
        return (title.match(/(2160p|1080p|720p|480p)/i) || [])[1] || 'Unknown';
    }

    function streamsFromTorrentio(res) {
        var streams = [];
        ((res && res.streams) || []).forEach(function (s) {
            var source  = buildStreamLabel(s.title || '', s.name || '');
            var quality = getQuality(s.title || s.name || '');
            var url     = s.infoHash ? buildMagnet(s.infoHash, s.name) : s.url;
            if (url) streams.push(new StreamResult({ url: url, quality: quality, source: source, headers: {} }));
        });
        return streams;
    }

    // ─── TMDB / Movies & Series ───────────────────────────────────────────────

    function tmdbToItem(m) {
        return new MultimediaItem({
            title:          (m.title || m.name || 'Unknown').trim(),
            url:            'tmdb:' + (m.media_type || (m.title ? 'movie' : 'tv')) + ':' + m.id,
            posterUrl:      imgUrl(m.poster_path),
            type:           m.media_type === 'movie' ? 'movie' : 'series',
            score:          m.vote_average || undefined,
            playbackPolicy: 'torrent'
        });
    }

    var TMDB_HOME_CATEGORIES = [
        { name: 'Trending',         url: TMDB_API + '/trending/all/day?api_key='                  + TMDB_KEY + '&region=US' },
        { name: 'Popular Movies',   url: TMDB_API + '/trending/movie/week?api_key='               + TMDB_KEY + '&region=US&with_original_language=en' },
        { name: 'Popular TV Shows', url: TMDB_API + '/trending/tv/week?api_key='                  + TMDB_KEY + '&region=US&with_original_language=en' },
        { name: 'Airing Today',     url: TMDB_API + '/tv/airing_today?api_key='                   + TMDB_KEY + '&region=US&with_original_language=en' },
        { name: 'Netflix',          url: TMDB_API + '/discover/tv?api_key='                       + TMDB_KEY + '&with_networks=213' },
        { name: 'Amazon',           url: TMDB_API + '/discover/tv?api_key='                       + TMDB_KEY + '&with_networks=1024' },
        { name: 'Disney+',          url: TMDB_API + '/discover/tv?api_key='                       + TMDB_KEY + '&with_networks=2739' },
        { name: 'Hulu',             url: TMDB_API + '/discover/tv?api_key='                       + TMDB_KEY + '&with_networks=453' },
        { name: 'Apple TV+',        url: TMDB_API + '/discover/tv?api_key='                       + TMDB_KEY + '&with_networks=2552' },
        { name: 'HBO',              url: TMDB_API + '/discover/tv?api_key='                       + TMDB_KEY + '&with_networks=49' },
        { name: 'Top Rated Movies', url: TMDB_API + '/movie/top_rated?api_key='                   + TMDB_KEY + '&region=US' },
        { name: 'Top Rated Shows',  url: TMDB_API + '/tv/top_rated?api_key='                      + TMDB_KEY + '&region=US' },
        { name: 'Korean Shows',     url: TMDB_API + '/discover/tv?api_key='                       + TMDB_KEY + '&with_original_language=ko' }
    ];

    async function torrentioGetHome(cb) {
        try {
            var result = {};
            await Promise.all(TMDB_HOME_CATEGORIES.map(async function (cat) {
                try {
                    var json = parseJSON(await http_get(cat.url, HTML_HEADERS));
                    if (!json?.results?.length) return;
                    result[cat.name] = json.results.map(tmdbToItem);
                } catch (_) {}
            }));
            if (!Object.keys(result).length) return cb({ success: false, error: 'Failed to load homepage.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioSearch(query, cb) {
        try {
            var json  = parseJSON(await http_get(
                TMDB_API + '/search/multi?api_key=' + TMDB_KEY + '&language=en-US&query=' + encodeURIComponent(query) + '&page=1&include_adult=false',
                HTML_HEADERS
            ));
            var items = ((json?.results) || [])
                .filter(function (m) { return m.media_type === 'movie' || m.media_type === 'tv'; })
                .map(tmdbToItem);
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
                TMDB_API + '/' + tmdbType + '/' + tmdbId + '?api_key=' + TMDB_KEY + '&append_to_response=credits,external_ids,videos,recommendations',
                HTML_HEADERS
            ));
            if (!res) return cb({ success: false, error: 'Failed to load detail.' });

            var title   = res.title || res.name || 'Unknown';
            var poster  = imgUrl(res.poster_path);
            var banner  = imgUrl(res.backdrop_path);
            var imdbId  = res.external_ids?.imdb_id || '';
            var year    = parseInt((res.release_date || res.first_air_date || '').split('-')[0]) || undefined;
            var isAnime = (res.genres || []).some(function (g) { return g.name === 'Animation'; })
                       && (res.original_language === 'ja' || res.original_language === 'zh');

            var cast = ((res.credits?.cast) || []).slice(0, 15).map(function (c) {
                return new Actor({ name: c.name || 'Unknown', role: c.character || 'Supporting', image: imgUrl(c.profile_path) });
            });

            var trailers = [];
            var tr = ((res.videos?.results) || []).find(function (v) { return v.type === 'Trailer'; });
            if (tr) trailers = [new Trailer({ url: 'https://www.youtube.com/watch?v=' + tr.key })];

            var recommendations = ((res.recommendations?.results) || []).slice(0, 10).map(function (m) {
                return new MultimediaItem({
                    title:     (m.title || m.name || 'Unknown').trim(),
                    url:       'tmdb:' + (m.title ? 'movie' : 'tv') + ':' + m.id,
                    posterUrl: imgUrl(m.poster_path),
                    type:      m.title ? 'movie' : 'series'
                });
            });

            var epPayload = { type: isMovie ? 'movie' : 'tv', imdbId: imdbId, title: title, year: year, isAnime: isAnime };

            if (isMovie) {
                return cb({ success: true, data: new MultimediaItem({
                    title, url, posterUrl: poster, bannerUrl: banner, type: 'movie',
                    description: res.overview || '', year, score: res.vote_average || undefined,
                    cast, trailers, recommendations, playbackPolicy: 'torrent',
                    episodes: [new Episode({
                        name: title, season: 1, episode: 1, posterUrl: poster, playbackPolicy: 'torrent',
                        url: JSON.stringify(epPayload)
                    })]
                })});
            }

            var episodes = [];
            await Promise.all((res.seasons || []).map(async function (s) {
                if (!s.season_number) return;
                try {
                    var seasonRes = parseJSON(await http_get(
                        TMDB_API + '/tv/' + tmdbId + '/season/' + s.season_number + '?api_key=' + TMDB_KEY,
                        HTML_HEADERS
                    ));
                    (seasonRes?.episodes || []).forEach(function (ep) {
                        episodes.push(new Episode({
                            name:           ep.name || ('Episode ' + ep.episode_number),
                            url:            JSON.stringify({ ...epPayload, season: ep.season_number, episode: ep.episode_number }),
                            season:         ep.season_number,
                            episode:        ep.episode_number,
                            posterUrl:      imgUrl(ep.still_path) || poster,
                            description:    ep.overview || '',
                            airDate:        ep.air_date || '',
                            runtime:        ep.runtime || undefined,
                            playbackPolicy: 'torrent'
                        }));
                    });
                } catch (_) {}
            }));

            episodes.sort(function (a, b) {
                return a.season !== b.season ? a.season - b.season : a.episode - b.episode;
            });

            cb({ success: true, data: new MultimediaItem({
                title, url, posterUrl: poster, bannerUrl: banner, type: 'series',
                description: res.overview || '', year, score: res.vote_average || undefined,
                cast, trailers, recommendations, playbackPolicy: 'torrent', episodes
            })});
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioLoadStreams(url, cb) {
        try {
            var data    = JSON.parse(url);
            var imdbId  = data.imdbId;
            var isMovie = data.type === 'movie';
            if (!imdbId) return cb({ success: false, error: 'No IMDB ID available. Torrentio requires an IMDB ID.' });

            var endpoint = isMovie
                ? manifest.baseUrl + '/stream/movie/' + imdbId + '.json'
                : manifest.baseUrl + '/stream/series/' + imdbId + ':' + data.season + ':' + data.episode + '.json';

            var res     = parseJSON(await http_get(endpoint, HTML_HEADERS));
            var streams = streamsFromTorrentio(res);

            if (!streams.length) return cb({ success: false, error: 'No streams found.' });
            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── AniList / Anime ──────────────────────────────────────────────────────

    function aniMediaToItem(m) {
        return new MultimediaItem({
            title:          ((m.title?.english || m.title?.romaji) || 'Unknown'),
            url:            'anilist:' + m.id,
            posterUrl:      m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || '',
            type:           'anime',
            score:          m.averageScore || undefined,
            playbackPolicy: 'torrent'
        });
    }

    var ANILIST_HOME_SECTIONS = [
        { name: 'Trending',            query: 'query{Page(perPage:' + MEDIA_LIMIT + '){media(sort:[TRENDING_DESC,POPULARITY_DESC],isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}' },
        { name: 'Popular This Season', query: 'query{Page(perPage:' + MEDIA_LIMIT + '){media(sort:[TRENDING_DESC,POPULARITY_DESC],season:SPRING,isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}' },
        { name: 'All Time Popular',    query: 'query{Page(perPage:' + MEDIA_LIMIT + '){media(sort:[POPULARITY_DESC],isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}' },
        { name: 'Top 100 Anime',       query: 'query{Page(perPage:' + MEDIA_LIMIT + '){media(sort:[SCORE_DESC],isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}' }
    ];

    async function torrentioAnimeGetHome(cb) {
        try {
            var result = {};
            await Promise.all(ANILIST_HOME_SECTIONS.map(async function (s) {
                try {
                    var json  = await anilistQuery(s.query);
                    var media = json?.data?.Page?.media;
                    if (media?.length) result[s.name] = media.map(aniMediaToItem);
                } catch (_) {}
            }));
            if (!Object.keys(result).length) return cb({ success: false, error: 'Failed to load homepage.' });
            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioAnimeSearch(query, cb) {
        try {
            var q    = 'query($s:String){Page(perPage:' + MEDIA_LIMIT + '){media(search:$s,isAdult:false,type:ANIME){id averageScore title{english romaji}coverImage{extraLarge large medium}}}}';
            var json = await anilistQuery(q, { s: query });
            cb({ success: true, data: (json?.data?.Page?.media || []).map(aniMediaToItem) });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioAnimeLoad(url, cb) {
        try {
            var anilistId = url.replace('anilist:', '');
            var q = 'query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english}startDate{year}description averageScore status bannerImage coverImage{extraLarge large}episodes format nextAiringEpisode{episode}airingSchedule{nodes{episode}}recommendations{edges{node{mediaRecommendation{id title{romaji english}coverImage{extraLarge large medium}}}}}}}';
            var json = await anilistQuery(q, { id: parseInt(anilistId) });
            var data = json?.data?.Media;
            if (!data) return cb({ success: false, error: 'Failed to load anime detail.' });

            var title   = data.title?.english || data.title?.romaji || 'Unknown';
            var poster  = data.coverImage?.extraLarge || data.coverImage?.large || '';
            var banner  = data.bannerImage || '';
            var year    = data.startDate?.year || undefined;
            var isMovie = (data.format || '').toLowerCase().includes('movie');
            var status  = (data.status || '').toLowerCase().includes('releasing') ? 'ongoing' : 'completed';

            var totalEps = data.nextAiringEpisode?.episode
                ? data.nextAiringEpisode.episode - 1
                : (data.episodes || data.airingSchedule?.nodes?.[0]?.episode || 0);

            var [aniZipRes] = await Promise.all([
                http_get(ANI_ZIP + '?anilist_id=' + anilistId, HTML_HEADERS)
            ]);
            var aniZip      = parseJSON(aniZipRes);
            var aniEpisodes = aniZip?.episodes || {};
            var aniTitles   = aniZip?.titles   || {};
            var kitsuId     = aniZip?.mappings?.kitsu_id || null;

            var recommendations = ((data.recommendations?.edges) || []).slice(0, 10).map(function (edge) {
                var rec = edge.node?.mediaRecommendation;
                if (!rec) return null;
                return new MultimediaItem({
                    title:     rec.title?.english || rec.title?.romaji || 'Unknown',
                    url:       'anilist:' + rec.id,
                    posterUrl: rec.coverImage?.large || rec.coverImage?.medium || '',
                    type:      'anime'
                });
            }).filter(Boolean);

            var epPayload = { type: isMovie ? 'movie' : 'series', anilistId: anilistId, kitsuId: kitsuId, title: title, year: year };

            var episodes = [];
            if (isMovie) {
                episodes = [new Episode({
                    name: title, season: 1, episode: 1, posterUrl: poster, playbackPolicy: 'torrent',
                    url: JSON.stringify({ ...epPayload, episode: 1 })
                })];
            } else {
                // Use AniZip absolute episode mapping to determine correct season/episode
                for (var i = 1; i <= totalEps; i++) {
                    var aniEp   = aniEpisodes[String(i)] || null;
                    var epTitle = aniEp?.title?.en || aniEp?.title?.['x-jat'] || aniEp?.title?.ja
                               || aniTitles.en || ('Episode ' + i);

                    // AniZip provides seasonNumber for absolute-numbered anime (e.g. S4 of AoT)
                    var season  = aniEp?.seasonNumber || 1;

                    episodes.push(new Episode({
                        name:           epTitle,
                        url:            JSON.stringify({ ...epPayload, episode: i }),
                        season:         season,
                        episode:        i,
                        posterUrl:      aniEp?.image || poster,
                        description:    aniEp?.overview ? String(aniEp.overview) : '',
                        airDate:        (aniEp?.airDateUtc || aniEp?.airdate || '').slice(0, 10),
                        runtime:        aniEp?.runtime || undefined,
                        dubStatus:      'subbed',
                        playbackPolicy: 'torrent'
                    }));
                }
            }

            cb({ success: true, data: new MultimediaItem({
                title:           aniTitles.en || title,
                url,
                posterUrl:       poster,
                bannerUrl:       banner,
                type:            'anime',
                description:     data.description || '',
                year,
                score:           data.averageScore || undefined,
                status,
                recommendations,
                playbackPolicy:  'torrent',
                episodes
            })});
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    async function torrentioAnimeLoadStreams(url, cb) {
        try {
            var data    = JSON.parse(url);
            var kitsuId = data.kitsuId;
            var episode = data.episode || 1;
            var isMovie = data.type === 'movie';
            if (!kitsuId) return cb({ success: false, error: 'Kitsu ID not found for this anime.' });

            var endpoint = isMovie
                ? manifest.baseUrl + '/stream/movie/kitsu:' + kitsuId + '.json'
                : manifest.baseUrl + '/stream/series/kitsu:' + kitsuId + ':' + episode + '.json';

            var res     = parseJSON(await http_get(endpoint, HTML_HEADERS));
            var streams = streamsFromTorrentio(res);

            if (!streams.length) return cb({ success: false, error: 'No streams found.' });
            cb({ success: true, data: streams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Router ───────────────────────────────────────────────────────────────
    async function getHome(cb)             { return isAnimeProvider ? torrentioAnimeGetHome(cb)          : torrentioGetHome(cb); }
    async function search(query, cb)       { return isAnimeProvider ? torrentioAnimeSearch(query, cb)    : torrentioSearch(query, cb); }
    async function load(url, cb)           { return isAnimeProvider ? torrentioAnimeLoad(url, cb)        : torrentioLoad(url, cb); }
    async function loadStreams(url, cb)    { return isAnimeProvider ? torrentioAnimeLoadStreams(url, cb) : torrentioLoadStreams(url, cb); }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome     = getHome;
    globalThis.search      = search;
    globalThis.load        = load;
    globalThis.loadStreams  = loadStreams;

})();