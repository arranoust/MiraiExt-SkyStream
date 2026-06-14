(function () {
    const TMDB_API = "https://db.videasy.to/3";
    const TMDB_IMG = "https://image.tmdb.org/t/p/w500";
    const DECRYPTION_API = "https://enc-dec.app/api/dec-videasy";

    const VIDEASY_SERVERS = [
        { name: "Neon",   path: "mb-flix",    audio: "Original" },
        { name: "Yoru",   path: "cdn",         audio: "Original", movieOnly: true },
        { name: "Cypher", path: "downloader2", audio: "Original" },
        { name: "Sage",   path: "1movies",     audio: "Original" },
        { name: "Breach", path: "m4uhd",       audio: "Original" },
        { name: "Vyse",   path: "hdmovie",     audio: "Original" },
    ];

    // ========================= Utilities =========================

    function tmdbUrl(path, params) {
        const qs = Object.entries({ language: "en-US", ...params })
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
        return `${TMDB_API}/${path}?${qs}`;
    }

    function posterUrl(path) {
        return path ? `${TMDB_IMG}${path}` : null;
    }

    function mediaToItem(m) {
        const type = m.media_type ?? (m.title ? "movie" : "tv");
        const title = m.title ?? m.name ?? "Unknown";
        return new MultimediaItem({
            title,
            url: `/${type}/${m.id}`,
            posterUrl: posterUrl(m.poster_path),
            type: type === "movie" ? "movie" : "series",
        });
    }

    function apiOrigin(url) {
        return url.replace(/https?:\/\/www\./, "https://");
    }

    function parseStatus(s) {
        if (!s) return null;
        if (s === "Released" || s === "Ended") return "completed";
        if (s === "Returning Series" || s === "In Production") return "ongoing";
        return null;
    }

    // ========================= getHome =========================

    async function getHome(cb) {
        const [trending, movies, tv] = await Promise.all([
            http_get(tmdbUrl("trending/all/week")).then(r => JSON.parse(r.body)),
            http_get(tmdbUrl("discover/movie", { sort_by: "popularity.desc", page: 1 })).then(r => JSON.parse(r.body)),
            http_get(tmdbUrl("discover/tv", { sort_by: "popularity.desc", page: 1 })).then(r => JSON.parse(r.body)),
        ]);

        cb({
            success: true,
            data: {
                "Trending": (trending.results || [])
                    .filter(m => m.media_type === "movie" || m.media_type === "tv")
                    .map(mediaToItem),
                "Popular Movies": (movies.results || []).map(m => { m.media_type = "movie"; return mediaToItem(m); }),
                "Popular TV Shows": (tv.results || []).map(m => { m.media_type = "tv"; return mediaToItem(m); }),
            },
        });
    }

    // ========================= search =========================

    async function search(query, cb) {
        const r = await http_get(tmdbUrl("search/multi", { query, page: 1 }));
        const data = JSON.parse(r.body);
        cb({
            success: true,
            data: (data.results || [])
                .filter(m => m.media_type === "movie" || m.media_type === "tv")
                .map(mediaToItem),
        });
    }

    // ========================= load =========================

    async function load(url, cb) {
        const [, type, id] = url.match(/\/(movie|tv)\/(\d+)/) || [];
        if (!type) return cb({ success: false, errorCode: "NOT_FOUND", message: "Invalid URL" });

        const detail = await http_get(tmdbUrl(`${type}/${id}`, { append_to_response: "external_ids" }))
            .then(r => JSON.parse(r.body));

        const isMovie = type === "movie";
        const title = detail.title ?? detail.name ?? "Unknown";
        const year = (detail.release_date ?? detail.first_air_date ?? "").slice(0, 4);
        const imdbId = detail.external_ids?.imdb_id ?? "";

        const item = new MultimediaItem({
            title,
            url,
            posterUrl: posterUrl(detail.poster_path),
            bannerUrl: detail.backdrop_path ? `https://image.tmdb.org/t/p/w1280${detail.backdrop_path}` : null,
            type: isMovie ? "movie" : "series",
            year: year ? parseInt(year) : null,
            score: detail.vote_average ? parseFloat(detail.vote_average.toFixed(1)) : null,
            description: detail.overview || null,
            status: parseStatus(detail.status),
            syncData: { tmdb: String(id) },
        });

        const extra = encodeURIComponent(JSON.stringify({ title, year, imdbId }));

        if (isMovie) {
            item.episodes = [new Episode({
                name: "Movie",
                url: `movie/${id}?extra=${extra}`,
                season: 1,
                episode: 1,
            })];
        } else {
            const seasons = (detail.seasons || []).filter(s => s.season_number > 0);
            const seasonDetails = await Promise.all(
                seasons.map(s =>
                    http_get(tmdbUrl(`tv/${id}/season/${s.season_number}`))
                        .then(r => ({ sNum: s.season_number, data: JSON.parse(r.body) }))
                )
            );

            const episodes = [];
            for (const { sNum, data } of seasonDetails) {
                for (const ep of (data.episodes || [])) {
                    episodes.push(new Episode({
                        name: `S${sNum} E${ep.episode_number} - ${ep.name}`,
                        url: `tv/${id}/${sNum}/${ep.episode_number}?extra=${extra}`,
                        season: sNum,
                        episode: ep.episode_number,
                        airDate: ep.air_date || null,
                        description: ep.overview || null,
                        posterUrl: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null,
                    }));
                }
            }
            item.episodes = episodes.reverse();
        }

        cb({ success: true, data: item });
    }

    // ========================= loadStreams =========================

    function parseQuery(queryStr) {
        const out = {};
        for (const pair of (queryStr || "").split("&")) {
            const [k, v] = pair.split("=");
            if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || "");
        }
        return out;
    }

    function buildQS(obj) {
        return Object.entries(obj)
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => `${encodeURIComponent(k)}=${v}`)
            .join("&");
    }

    function buildLabel(server, quality) {
        const parts = [`[${server.name}]`];
        if (quality && quality !== "Auto") parts.push(quality);
        if (server.audio && server.audio !== "Original") parts.push(server.audio);
        return parts.join(" ");
    }

    function buildStreams(server, result, referer, origin) {
        const subtitles = (result.subtitles || [])
            .filter(s => s.url && s.language)
            .slice(0, 25)
            .map(s => ({ url: s.url, label: s.language, lang: s.language }));

        const headers = { "Referer": referer, "Origin": origin };

        function proxyUrl(url) {
            return "MAGIC_PROXY_v1" + btoa(url);
        }

        if (result.sources && result.sources.length > 0) {
            const sources = server.qualityFilter
                ? result.sources.filter(s => (s.quality || "").toLowerCase() === server.qualityFilter.toLowerCase())
                : result.sources;
            return sources.map(src =>
                new StreamResult({ url: proxyUrl(src.url), source: buildLabel(server, src.quality || ""), headers, subtitles })
            );
        }

        if (result.streams) {
            return Object.entries(result.streams).map(([q, url]) =>
                new StreamResult({ url: proxyUrl(url), source: buildLabel(server, q), headers, subtitles })
            );
        }

        if (result.url) {
            return [new StreamResult({ url: proxyUrl(result.url), source: buildLabel(server, ""), headers, subtitles })];
        }

        return [];
    }

    async function loadStreams(url, cb) {
        const [pathPart, queryPart] = url.split("?");
        const qp = parseQuery(queryPart);
        const extra = JSON.parse(decodeURIComponent(qp.extra || "{}"));
        const { title = "", year = "", imdbId = "" } = extra;

        const segments = pathPart.split("/");
        const isMovie = segments[0] === "movie";
        const tmdbId = segments[1];
        const seasonId = isMovie ? "1" : segments[2];
        const episodeId = isMovie ? "1" : segments[3];
        const mediaType = isMovie ? "movie" : "tv";

        const origin = apiOrigin(manifest.baseUrl);
        const referer = `${origin}/`;

        const streams = await Promise.all(
            VIDEASY_SERVERS
                .filter(s => !s.movieOnly || isMovie)
                .map(async server => {
                    try {
                        const qsObj = {
                            title: encodeURIComponent(title),
                            mediaType,
                            year,
                            episodeId,
                            seasonId,
                            tmdbId,
                        };
                        if (imdbId) qsObj.imdbId = imdbId;

                        const serverUrl = `https://api.videasy.to/${server.path}/sources-with-title?${buildQS(qsObj)}`;
                        const encRes = await http_get(serverUrl, {
                            headers: { "Referer": referer, "Origin": origin },
                        });

                        const postBody = JSON.stringify({ text: encRes.body, id: tmdbId });
                        const decRes = await http_post(DECRYPTION_API, { "Content-Type": "application/json" }, postBody);

                        const raw = typeof decRes.body === "string" ? JSON.parse(decRes.body) : decRes.body;
                        if (!raw || raw.status !== 200) return [];
                        return buildStreams(server, raw.result, referer, origin);
                    } catch (e) {
                        console.log(`[${server.name}] error: ${e}`);
                        return [];
                    }
                })
        );

        const flat = streams.flat();
        cb({ success: true, data: flat });
    }

    // ========================= Exports =========================

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();