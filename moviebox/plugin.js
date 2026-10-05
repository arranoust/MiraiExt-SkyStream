(function () {
  // ─── Config ───────────────────────────────────────────────────────────────
  var BASE_URL = manifest.baseUrl;
  var API_BASE = "https://h5-api.aoneroom.com";
  var UA =
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.3";

  // Ranking ID untuk fallback search (jika /subject/search gagal/kosong)
  var RANKING_IDS = [
    "872031290915189720", // Trending
    "8821254238245470240", // Trending Movies
    "4380734070238626200", // K-Drama: New Release
    "6528093688173053896", // Trending Indonesia
  ];

  var BASE_HEADERS = {
    "User-Agent": UA,
    Accept: "application/json",
    "X-Client-Info": '{"timezone":"Asia/Jakarta"}',
  };

  // Batas item per section (pagination /ranking-list/content)
  var MAX_ITEMS = 100;

  // Header untuk scrape halaman SSR (halaman search meng-render kartu di server)
  var HTML_HEADERS = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  // ─── Bearer token cache (dari response header x-user di /home) ────────────
  var _bearerToken = null;
  var _bearerExpiry = 0;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function getBody(res) {
    if (!res) return "";
    if (typeof res === "string") return res;
    if (typeof res.body === "string") return res.body;
    if (res.body && typeof res.body === "object")
      return JSON.stringify(res.body);
    return "";
  }

  function parseJSON(res) {
    var txt = getBody(res);
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch (_) {
      return null;
    }
  }

  function decodeEntities(s) {
    if (!s) return "";
    return String(s)
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#x27;/gi, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, function (_, n) {
        return String.fromCharCode(parseInt(n, 10));
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  // ─── Parse kartu hasil search dari HTML SSR /newWeb/searchResult ─────────
  // SSR merender: <a href="/moviesDetail/SLUG" ...> ... <h2 class="card-title"
  // title="TITLE"> ... <span class="rate ...">5.6</span> ... </a>
  // Poster tidak ada di SSR (di-set client-side), diambil lewat /detail.
  function parseSearchCards(html) {
    if (!html || html.indexOf("/moviesDetail/") === -1) return [];
    var out = [];
    var seen = {};
    var re =
      /<a\b[^>]*href="\/moviesDetail\/([^"'?#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var slug = decodeEntities(m[1]);
      var inner = m[2] || "";
      if (!slug || seen[slug]) continue;

      var titleM = inner.match(/<h2\b[^>]*\btitle="([^"]*)"/i);
      var title = decodeEntities(titleM ? titleM[1] : "");
      if (!title) {
        var textM = inner.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
        title = decodeEntities(textM ? textM[1].replace(/<[^>]+>/g, "") : "");
      }
      if (!title) continue;

      var score = null;
      var rateM = inner.match(/class="rate[^"]*"[^>]*>\s*([\d.]+)\s*</i);
      if (rateM) {
        var r = parseFloat(rateM[1]);
        if (!isNaN(r)) score = r;
      }

      seen[slug] = true;
      out.push({
        slug: slug,
        title: title,
        score: score,
        poster: null,
        type: null,
        year: undefined,
      });
    }
    return out;
  }

  // Parallel GET /detail untuk slug hasil search (poster + subjectType + year)
  async function enrichSearchItems(items) {
    if (!items.length) return items;
    var limit = Math.min(items.length, 20);
    var reqs = [];
    for (var i = 0; i < limit; i++) {
      var slug = items[i].slug;
      reqs.push({
        url:
          API_BASE +
          "/wefeed-h5api-bff/detail?detailPath=" +
          encodeURIComponent(slug),
        headers: buildAuthHeaders({
          Referer: BASE_URL + "/moviesDetail/" + slug,
        }),
      });
    }

    var res = null;
    if (typeof http_parallel === "function") {
      try {
        res = await http_parallel(
          reqs.map(function (r) {
            return { method: "GET", url: r.url, headers: r.headers };
          })
        );
      } catch (_) {
        res = null;
      }
    }
    if (!res || !res.length) {
      res = await Promise.all(
        reqs.map(function (r) {
          return http_get(r.url, r.headers).catch(function () {
            return null;
          });
        })
      );
    }

    for (var j = 0; j < limit; j++) {
      var json = parseJSON(res[j]);
      var subject = json && json.data && json.data.subject;
      if (!subject) continue;
      var cover = subject.cover && subject.cover.url;
      if (cover) items[j].poster = String(cover);
      if (subject.subjectType)
        items[j].type = toTvType(toInt(subject.subjectType));
      var year = parseInt(
        String(subject.releaseDate || "").substring(0, 4),
        10
      );
      if (!isNaN(year)) items[j].year = year;
      var rating = parseFloat(subject.imdbRatingValue);
      if (!isNaN(rating) && rating > 0) items[j].score = rating;
    }
    return items;
  }

  function toInt(v) {
    if (typeof v === "number") return Math.round(v);
    if (typeof v === "string") {
      var n = parseInt(v, 10);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  // X-Client-Token header. API moviebox menerima nilai apapun di sini
  // (verified via curl), jadi kita hanya perlu format "<ts>,<32-char>" ala CS.
  function clientTimeToken() {
    var ts = Math.floor(Date.now() / 1000);
    return String(ts) + ",00000000000000000000000000000000";
  }

  function getHeader(headers, name) {
    if (!headers) return null;
    var lname = name.toLowerCase();
    for (var k in headers) {
      if (
        Object.prototype.hasOwnProperty.call(headers, k) &&
        k.toLowerCase() === lname
      ) {
        return headers[k];
      }
    }
    return null;
  }

  function toTvType(subjectType) {
    if (subjectType === 2) return "anime";
    if (subjectType === 3) return "series";
    return "movie";
  }

  function subjectToItem(s) {
    if (!s) return null;
    var detailPath = s.detailPath;
    var title = s.title;
    if (!detailPath || !title) return null;
    var cover = (s.cover && s.cover.url) || null;
    var stype = toInt(s.subjectType);
    return new MultimediaItem({
      title: title,
      url: BASE_URL + "/moviesDetail/" + detailPath,
      posterUrl: cover || undefined,
      type: toTvType(stype),
    });
  }

  function buildAuthHeaders(extra) {
    var h = Object.assign({}, BASE_HEADERS, {
      "X-Request-Lang": "en",
      "X-Client-Token": clientTimeToken(),
    });
    if (_bearerToken) h["Authorization"] = "Bearer " + _bearerToken;
    if (extra) Object.assign(h, extra);
    return h;
  }

  // GET $API_BASE$path dengan Bearer (jika ada). Mengembalikan JSON object.
  async function apiGet(path) {
    var res = await http_get(
      API_BASE + path,
      buildAuthHeaders({ Referer: BASE_URL + "/" })
    );
    return parseJSON(res);
  }

  // GET $BASE_URL$path dengan Bearer. Endpoint subject/play harus ke host themoviebox.org
  // dengan Referer = path detail (API moviebox memvalidasi Referer).
  async function tokenGet(path, referer) {
    var hdrs = buildAuthHeaders({ Referer: referer || BASE_URL + "/" });
    var res = await http_get(BASE_URL + path, hdrs);
    return parseJSON(res);
  }

  // Ambil token dari header x-user response /home?host=themoviebox.org
  async function getBearerToken() {
    if (_bearerToken && Date.now() < _bearerExpiry) return _bearerToken;
    try {
      var headers = Object.assign({}, BASE_HEADERS, {
        "X-Request-Lang": "en",
        "X-Client-Token": clientTimeToken(),
      });
      var res = await http_get(
        API_BASE + "/wefeed-h5api-bff/home?host=themoviebox.org",
        Object.assign(headers, { Referer: BASE_URL + "/" })
      );
      var xUser = getHeader(res && res.headers, "x-user") || "";
      if (xUser) {
        var parsed = parseJSON(xUser);
        var tok = parsed && parsed.token;
        if (tok) {
          _bearerToken = String(tok);
          _bearerExpiry = Date.now() + 24 * 60 * 60 * 1000; // cache 24h
          return _bearerToken;
        }
      }
    } catch (_) {
      /* abaikan */
    }
    return null;
  }

  // ─── getHome ──────────────────────────────────────────────────────────────
  // Semua kategori dari endpoint /home (operatingList).
  async function getHome(cb) {
    try {
      var json = await apiGet("/wefeed-h5api-bff/home?host=themoviebox.org");
      var sections = (json && json.data && json.data.operatingList) || [];
      var data = {};
      var tasks = sections.map(async function (section) {
        if (!section || !section.genreTopId) return;
        var title = section.title || "Trending";
        try {
          var items = [];
          var page = 1;
          var hasMore = true;
          while (hasMore) {
            var jsonSection = await apiGet(
              "/wefeed-h5api-bff/ranking-list/content?id=" +
                section.genreTopId +
                "&page=" +
                page +
                "&perPage=20"
            );
            var dataSection = (jsonSection && jsonSection.data) || {};
            var list = dataSection.subjectList || [];
            for (var j = 0; j < list.length; j++) {
              var it = subjectToItem(list[j]);
              if (it) items.push(it);
            }
            var pager = dataSection.pager || {};
            hasMore = pager.hasMore === true && items.length < MAX_ITEMS;
            page = (parseInt(pager.page, 10) || page) + 1;
          }
          if (items.length) data[title] = items;
          // console.log(items.length + " items for section: " + title);
        } catch (_) {
          // skip section gagal
        }
      });
      await Promise.all(tasks);
      if (!Object.keys(data).length)
        return cb({ success: false, error: "No data from API." });
      cb({ success: true, data: data });
      // cb({ success: true });
    } catch (e) {
      cb({ success: false, error: String(e) });
    }
  }

  // ─── search (scrape SSR /newWeb/searchResult) ───────────────────────────
  async function search(query, cb) {
    try {
      var keyword = String(query || "").trim();
      if (!keyword) return cb({ success: false, error: "Empty query." });

      var items = [];
      try {
        var html = getBody(
          await http_get(
            BASE_URL +
              "/newWeb/searchResult?keyword=" +
              encodeURIComponent(keyword),
            HTML_HEADERS
          )
        );
        items = parseSearchCards(html);
      } catch (_) {
        items = [];
      }

      // Fallback ke API search kalau SSR tidak mengembalikan kartu
      if (!items.length)
        return cb({ success: true, data: await searchViaApi(keyword) });

      await enrichSearchItems(items);

      var results = [];
      items.forEach(function (it) {
        results.push(
          new MultimediaItem({
            title: it.title,
            url: BASE_URL + "/moviesDetail/" + it.slug,
            posterUrl: it.poster || undefined,
            type: it.type || "movie",
            year: it.year,
            score: it.score,
          })
        );
      });
      cb({ success: true, data: results });
    } catch (e) {
      cb({ success: false, error: String(e) });
    }
  }

  // Search via API (dipakai kalau scrape SSR gagal/kosong)
  async function searchViaApi(query) {
    try {
      var token = await getBearerToken();
      var allItems = [];

      if (token) {
        // Tahap 1: server-side search via /subject/search
        var page = 1,
          maxPages = 10,
          hasMore = true;
        while (page <= maxPages && hasMore) {
          var body = JSON.stringify({
            keyword: query,
            page: page,
            perPage: 28,
            subjectType: 0,
          });
          var res = await http_post(
            API_BASE + "/wefeed-h5api-bff/subject/search",
            buildAuthHeaders({
              "Content-Type": "application/json",
              Referer: BASE_URL + "/",
            }),
            body
          );
          var json = parseJSON(res);
          var data = (json && json.data) || {};
          var pager = data.pager || {};
          hasMore = pager.hasMore === true;
          var items = data.items || [];
          if (!items.length) break;
          items.forEach(function (s) {
            if (s && typeof s === "object") allItems.push(s);
          });
          page++;
        }
      }

      // Tahap 2: filter by title.contains (jalankan selalu setelah ranking/filter)
      if (!allItems.length) {
        for (var i = 0; i < RANKING_IDS.length; i++) {
          try {
            var json2 = await apiGet(
              "/wefeed-h5api-bff/ranking-list/content?id=" +
                RANKING_IDS[i] +
                "&page=1&perPage=20"
            );
            var list = (json2 && json2.data && json2.data.subjectList) || [];
            list.forEach(function (s) {
              if (s && typeof s === "object") allItems.push(s);
            });
          } catch (_) {
            /* skip */
          }
        }
      }
      // Filter by title query (selalu jalan, terlepas source data)
      var q = (query || "").toLowerCase();
      allItems = allItems.filter(function (s) {
        return s && s.title && String(s.title).toLowerCase().indexOf(q) !== -1;
      });
      // Dedup by detailPath (setelah filter)
      if (allItems.length) {
        var seen = {};
        allItems = allItems.filter(function (s) {
          var k = s.detailPath;
          if (!k || seen[k]) return false;
          seen[k] = true;
          return true;
        });
      }

      var results = [];
      allItems.forEach(function (s) {
        var it = subjectToItem(s);
        if (it) results.push(it);
      });
      return results;
    } catch (_) {
      return [];
    }
  }

  // ─── load ─────────────────────────────────────────────────────────────────
  async function load(url, cb) {
    try {
      var detailPath = String(url).split("?")[0].split("#")[0];
      var qIdx = url.indexOf("?");
      if (qIdx !== -1) detailPath = url.substring(0, qIdx);
      detailPath = detailPath.substring(detailPath.lastIndexOf("/") + 1);
      if (!detailPath) return cb({ success: false, error: "Invalid URL." });

      var json = await apiGet(
        "/wefeed-h5api-bff/detail?detailPath=" + detailPath
      );
      if (!json || !json.data)
        return cb({ success: false, error: "Invalid detail response." });

      var data = json.data;
      var subject = data.subject;
      if (!subject) return cb({ success: false, error: "Missing subject." });

      var title = subject.title || "Unknown";
      var subjectId = String(subject.subjectId || "");
      var stype = toInt(subject.subjectType);
      var tvType = toTvType(stype);
      var imdbRating = parseFloat(subject.imdbRatingValue);
      var plot = subject.description || "";
      var poster = (subject.cover && subject.cover.url) || undefined;
      var genre = subject.genre || "";
      var tags = genre
        ? String(genre)
            .split(",")
            .map(function (s) {
              return s.trim();
            })
            .filter(Boolean)
        : [];
      var year = (subject.releaseDate || "").substring(0, 4);
      year = parseInt(year);
      if (isNaN(year)) year = undefined;
      var dubs = Array.isArray(subject.dubs) ? subject.dubs : [];
      var resource = data.resource || {};
      var seasons = Array.isArray(resource.seasons) ? resource.seasons : [];

      var isSeriesLike =
        seasons.length > 0 && (toInt(seasons[0].maxEp) || 0) > 1;

      if (isSeriesLike) {
        // Series/Anime: loop seasons × episodes, buat Episode[]
        var primaryDubs = dubs.filter(function (d) {
          var t = toInt(d.type);
          return t === 5 || t === 0;
        });
        var primaryDub = primaryDubs[0];
        var dubSubjectId =
          primaryDub && primaryDub.subjectId
            ? String(primaryDub.subjectId)
            : subjectId;

        var episodes = [];
        seasons.forEach(function (s) {
          var seasonNo = toInt(s.se);
          if (!seasonNo) return;
          var allEp = s.allEp && String(s.allEp).trim();
          var eps;
          if (allEp) {
            eps = allEp
              .split(",")
              .map(function (n) {
                return toInt(n);
              })
              .filter(function (n) {
                return n !== null;
              });
          } else {
            var max = toInt(s.maxEp) || 0;
            eps = [];
            for (var i = 1; i <= max; i++) eps.push(i);
          }
          eps.forEach(function (ep) {
            var epUrl =
              BASE_URL +
              "/movies/" +
              detailPath +
              "?sid=" +
              encodeURIComponent(dubSubjectId) +
              "&se=" +
              seasonNo +
              "&ep=" +
              ep +
              "&id=" +
              encodeURIComponent(subjectId) +
              "&type=/movie/detail&detailSe=&detailEp=&lang=en";
            episodes.push(
              new Episode({
                name: "Episode " + ep,
                url: epUrl,
                season: seasonNo,
                episode: ep,
                posterUrl: poster,
              })
            );
          });
        });

        cb({
          success: true,
          data: new MultimediaItem({
            title: title,
            url: url,
            posterUrl: poster,
            type: tvType,
            year: year,
            score: isNaN(imdbRating) ? undefined : imdbRating,
            description: plot,
            tags: tags.length ? tags : undefined,
            episodes: episodes,
          }),
        });
        return;
      }

      // Movie (atau series tanpa seasons): satu Episode
      var movieUrl =
        BASE_URL +
        "/movies/" +
        detailPath +
        "?id=" +
        encodeURIComponent(subjectId) +
        "&type=/movie/detail&detailSe=&detailEp=&lang=en";

      cb({
        success: true,
        data: new MultimediaItem({
          title: title,
          url: url,
          posterUrl: poster,
          type: tvType,
          year: year,
          score: isNaN(imdbRating) ? undefined : imdbRating,
          description: plot,
          tags: tags.length ? tags : undefined,
          episodes: [
            new Episode({
              name: title,
              url: movieUrl,
              season: 1,
              episode: 1,
              posterUrl: poster,
            }),
          ],
        }),
      });
    } catch (e) {
      cb({ success: false, error: String(e) });
    }
  }

  // ─── loadStreams ───────────────────────────────────────────────────────────
  async function loadStreams(url, cb) {
    try {
      var detailPath = String(url)
        .split("?")[0]
        .split("#")[0]
        .substring(url.split("?")[0].split("#")[0].lastIndexOf("/") + 1);

      // Ambil sid, se, ep dari query string
      function getParam(name) {
        var m = url.match(new RegExp("[?&]" + name + "=([^&]+)"));
        return m ? decodeURIComponent(m[1]) : null;
      }
      var sid = getParam("sid") || getParam("id") || null;
      var se = getParam("se") || "0";
      var ep = getParam("ep") || "0";

      // Ambil detail untuk subjectId (jika sid kosong) dan dubs
      var detJson = await apiGet(
        "/wefeed-h5api-bff/detail?detailPath=" + detailPath
      );
      var detData = detJson && detJson.data;
      var detSubject = detData && detData.subject;
      var subjectId =
        (sid && String(sid)) ||
        (detSubject && detSubject.subjectId
          ? String(detSubject.subjectId)
          : "");
      if (!subjectId)
        return cb({ success: false, error: "Missing subjectId." });

      var dubs =
        detSubject && Array.isArray(detSubject.dubs) ? detSubject.dubs : [];

      // Kalau subject utama punya dubs, loop semua dubs. Kalau tidak, fallback ke 1 (original)
      var allDubs = dubs.length
        ? dubs
        : [{ subjectId: subjectId, lanName: "Original" }];

      var streams = [];
      var seenUrls = {};

      for (var i = 0; i < allDubs.length; i++) {
        var dub = allDubs[i];
        var dubId = dub.subjectId ? String(dub.subjectId) : subjectId;
        var dubName = dub.lanName ? String(dub.lanName) : "Unknown";

        var playJson;
        try {
          playJson = await tokenGet(
            "/wefeed-h5api-bff/subject/play?subjectId=" +
              encodeURIComponent(dubId) +
              "&se=" +
              se +
              "&ep=" +
              ep +
              "&detailPath=" +
              encodeURIComponent(detailPath),
            BASE_URL + "/movies/" + detailPath
          );
        } catch (_) {
          continue;
        }
        if (!playJson || !playJson.data) continue;
        var pData = playJson.data;
        if (pData.hasResource !== true) continue;

        var allSources = [].concat(
          pData.streams || [],
          pData.hls || [],
          pData.dash || []
        );

        // Ambil subtitle (sekali per dub, dari streams pertama yang punya id)
        var subtitle = [];

        for (var j = 0; j < allSources.length; j++) {
          var item = allSources[j];
          if (!item) continue;
          var u = item.url;
          if (!u || u.indexOf("http") !== 0) continue;
          if (seenUrls[u]) continue;
          seenUrls[u] = true;

          var res = item.resolutions ? String(item.resolutions) : "";
          var streamId = item.id ? String(item.id) : null;

          // Tentukan quality
          var quality = "Auto";
          var q = "Auto";
          var combined = res + " " + u;
          if (/1080/i.test(combined)) q = "1080p";
          else if (/720/i.test(combined)) q = "720p";
          else if (/480/i.test(combined)) q = "480p";
          else if (/360/i.test(combined)) q = "360p";
          quality = q;

          var label = (dubs.length ? dubName + " " : "") + (res || quality);

          streams.push(
            new StreamResult({
              url: u,
              quality: quality,
              source:
                "MovieBox" +
                (dubs.length ? " - " + dubName : "") +
                " " +
                (quality || "Auto"),
              headers: {
                Referer: BASE_URL + "/",
                "User-Agent": UA,
              },
              subtitles: subtitle.length ? subtitle : undefined,
            })
          );

          // Ambil subtitle hanya sekali (dari stream pertama yang punya id)
          if (subtitle.length === 0 && streamId) {
            try {
              var capRes = await http_get(
                API_BASE +
                  "/wefeed-h5api-bff/subject/caption?format=MP4&id=" +
                  encodeURIComponent(streamId) +
                  "&subjectId=" +
                  encodeURIComponent(dubId) +
                  "&detailPath=" +
                  encodeURIComponent(detailPath),
                buildAuthHeaders({ Referer: BASE_URL + "/" })
              );
              var capJson = parseJSON(capRes);
              var caps =
                (capJson && capJson.data && capJson.data.captions) || [];
              caps.forEach(function (cap) {
                if (!cap || !cap.url) return;
                var lang = cap.lanCode || cap.lan || "und";
                var lname = cap.lanName || lang;
                subtitle.push({
                  url: cap.url,
                  label: lname,
                  lang: String(lang),
                });
              });
              // Patch subtitle ke StreamResult terakhir
              if (subtitle.length)
                streams[streams.length - 1].subtitles = subtitle;
            } catch (_) {
              /* abaikan */
            }
          }
        }
      }

      if (!streams.length)
        return cb({ success: false, error: "Tidak ada stream yang tersedia." });
      cb({ success: true, data: streams });
    } catch (e) {
      cb({ success: false, error: String(e) });
    }
  }

  // ─── Expose ───────────────────────────────────────────────────────────────
  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
