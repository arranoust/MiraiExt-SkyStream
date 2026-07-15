(function () {

    // ─── Config ───────────────────────────────────────────────────────────────
    var BASE_URL   = 'https://www.animeonsen.xyz';
    var API_URL    = 'https://api.animeonsen.xyz/v4';
    var SEARCH_URL = 'https://search.animeonsen.xyz';

    // OAuth2 client credentials (from AOAPIInterceptor.kt)
    var CLIENT_ID     = 'f296be26-28b5-4358-b5a1-6259575e23b7';
    var CLIENT_SECRET = '349038c4157d0480784753841217270c3c5b35f4281eaee029de21cb04084235';
    var TOKEN_URL     = 'https://auth.animeonsen.xyz/oauth/token';

    var UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.3';

    var HEADERS = {
        'User-Agent':      UA,
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         BASE_URL + '/',
        'Origin':          BASE_URL
    };

    // ─── Token cache ──────────────────────────────────────────────────────────
    var _token         = null;
    var _searchToken   = null;

    async function getApiToken() {
        if (_token) return _token;
        try {
            var body = 'client_id=' + encodeURIComponent(CLIENT_ID)
                     + '&client_secret=' + encodeURIComponent(CLIENT_SECRET)
                     + '&grant_type=client_credentials';
            var res  = await http_post(TOKEN_URL, {
                'User-Agent': UA,
                'Accept':     'application/json',
                'Origin':     BASE_URL,
                'Referer':    BASE_URL + '/',
                'Content-Type': 'application/x-www-form-urlencoded'
            }, body);
            var json = JSON.parse(getBody(res));
            _token = json.access_token || null;
        } catch (_) { _token = null; }
        return _token;
    }

    // Search token is scraped from <meta name="ao-search-token"> on homepage (SearchInterceptor.kt)
    async function getSearchToken() {
        if (_searchToken) return _searchToken;
        try {
            var html  = getBody(await http_get(BASE_URL, { 'User-Agent': UA }));
            var m     = html.match(/<meta[^>]+name=["']ao-search-token["'][^>]+content=["']([^"']+)["']/i)
                     || html.match(/content=["']([^"']+)["'][^>]+name=["']ao-search-token["']/i);
            _searchToken = m ? m[1] : null;
        } catch (_) { _searchToken = null; }
        return _searchToken;
    }

    async function apiGet(path) {
        var token = await getApiToken();
        var hdrs  = Object.assign({}, HEADERS);
        if (token) hdrs['Authorization'] = 'Bearer ' + token;
        return JSON.parse(getBody(await http_get(API_URL + path, hdrs)));
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    }

    function posterUrl(contentId) {
        return API_URL + '/image/210x300/' + contentId;
    }

    function itemToMultimedia(item) {
        return new MultimediaItem({
            title:     item.content_title_en || item.content_title || item.content_title_jp || 'Unknown',
            url:       item.content_id,
            posterUrl: item.thumbnail || item.content_image || posterUrl(item.content_id),
            type:      'anime'
        });
    }

    // ─── getHome ──────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var json   = await apiGet('/content/index?start=0&limit=30');
            var items  = (json.content || []).map(itemToMultimedia);
            if (!items.length) return cb({ success: false, error: 'No content found.' });
            cb({ success: true, data: { 'Popular': items } });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ───────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var token = await getSearchToken();
            var hdrs  = {
                'User-Agent': UA,
                'Accept':     'application/json',
                'Referer':    BASE_URL + '/',
                'Origin':     BASE_URL
            };
            if (token) hdrs['Authorization'] = 'Bearer ' + token;

            var res   = await http_post(
                SEARCH_URL + '/indexes/content/search',
                Object.assign(hdrs, { 'Content-Type': 'application/json' }),
                JSON.stringify({ q: query })
            );
            var json  = JSON.parse(getBody(res));
            var items = (json.hits || []).map(itemToMultimedia);
            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ─────────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var contentId = url;
            var detail    = await apiGet('/content/' + contentId + '/extensive');

            var title    = detail.content_title_en || detail.content_title || 'Unknown';
            var poster   = posterUrl(contentId);
            var malData  = (typeof detail.mal_data === 'object' && detail.mal_data) ? detail.mal_data : {};

            // Build description
            var desc = '';
            if (malData.mean_score) {
                var stars = Math.round(malData.mean_score / 2);
                desc += '★'.repeat(Math.max(0, Math.min(stars, 5)))
                      + '☆'.repeat(Math.max(0, 5 - stars))
                      + ' ' + malData.mean_score + '\n\n';
            }
            if (malData.synopsis) desc += malData.synopsis;

            var extras = [];
            if (malData.rating) extras.push('Rating: ' + malData.rating.replace(/_/g, ' ').toUpperCase());
            if (detail.mal_id)  extras.push('MAL ID: ' + detail.mal_id);
            if (extras.length)  desc += '\n\n' + extras.join('\n');

            // Fetch episode list
            var epsJson  = await apiGet('/content/' + contentId + '/episodes');
            var episodes = [];
            var epKeys   = Object.keys(epsJson).sort(function (a, b) { return parseFloat(a) - parseFloat(b); });

            for (var i = 0; i < epKeys.length; i++) {
                var epNum = epKeys[i];
                var ep    = epsJson[epNum];
                var name  = ep.contentTitle_episode_en || ep.contentTitle_episode_jp || ('Episode ' + epNum);
                episodes.push(new Episode({
                    name:    'Episode ' + epNum + (name ? ': ' + name : ''),
                    url:     contentId + '/video/' + epNum,
                    season:  1,
                    episode: parseFloat(epNum) || (i + 1),
                    dubStatus: 'subbed'
                }));
            }

            var syncData = {};
            if (detail.mal_id) syncData.mal = String(detail.mal_id);

            cb({
                success: true,
                data: new MultimediaItem({
                    title,
                    url:         contentId,
                    posterUrl:   poster,
                    type:        'anime',
                    description: desc.trim(),
                    episodes,
                    syncData:    Object.keys(syncData).length ? syncData : undefined
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ───────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            // url = "{contentId}/video/{epNum}"
            var videoData = await apiGet('/content/' + url);

            var m3u8      = videoData.uri && videoData.uri.stream;
            if (!m3u8) return cb({ success: false, error: 'Stream URL not found.' });

            // Build subtitles: langPrefix → display name from metadata
            var subtitleMeta = (videoData.metadata && videoData.metadata.subtitles) || {};
            var subtitleUris = (videoData.uri && videoData.uri.subtitles) || {};

            var subtitles = Object.keys(subtitleUris).reduce(function (acc, lang) {
                var label = subtitleMeta[lang] || lang;
                acc.push({ url: subtitleUris[lang], label: label, lang: lang });
                return acc;
            }, []);

            // Sort: English first, then alphabetical
            subtitles.sort(function (a, b) {
                if (a.lang === 'en-US') return -1;
                if (b.lang === 'en-US') return 1;
                return a.lang.localeCompare(b.lang);
            });

            cb({
                success: true,
                data: [new StreamResult({
                    url:       m3u8,
                    quality:   '720p',
                    source:    'AnimeOnsen',
                    headers:   { Referer: BASE_URL + '/' },
                    subtitles: subtitles.length ? subtitles : undefined
                })]
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ───────────────────────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();
