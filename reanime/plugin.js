(function () {

    // ─── Config ──────────────────────────────────────────────────────────────
    var BASE_URL = 'https://reanime.to';
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

    var HEADERS = {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': BASE_URL + '/'
    };

    // ─── Helpers ─────────────────────────────────────────────────────────────
    function getBody(res) {
        if (!res) return '';
        if (typeof res === 'string') return res;
        if (typeof res.body === 'string') return res.body;
        if (res.body != null) {
            if (typeof res.body === 'object') {
                try { return JSON.stringify(res.body); } catch (_) { return ''; }
            }
            return String(res.body);
        }
        try { return JSON.stringify(res); } catch (_) { return ''; }
    }

    function parseJson(res) {
        var body = getBody(res);
        if (!body) return null;
        try { return JSON.parse(body); } catch (_) { return null; }
    }

    function base64ToBytes(b64) {
        var binary = atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function bytesToHex(bytes) {
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
            var v = bytes[i] & 0xff;
            hex += ('0' + (v >>> 4).toString(16)).slice(-2) + ('0' + (v & 0x0f).toString(16)).slice(-2);
        }
        return hex;
    }

    function stringToBytes(str) {
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'utf-8'));
        return new TextEncoder().encode(str);
    }

    // ─── Node.js crypto module ──────────────────────────────────────────────
    var nodeCrypto;
    try { nodeCrypto = __crypto__; } catch (_) { nodeCrypto = null; }

    // ─── SHA-256 ────────────────────────────────────────────────────────────
    function sha256String(text) {
        if (nodeCrypto && nodeCrypto.createHash) {
            return nodeCrypto.createHash('sha256').update(text, 'utf-8').digest('hex');
        }
        return bytesToHex(new Uint8Array(crypto.subtle.digest('SHA-256', stringToBytes(text))));
    }

    function sha256Bytes(data) {
        if (nodeCrypto && nodeCrypto.createHash) {
            return new Uint8Array(nodeCrypto.createHash('sha256').update(Buffer.from(data)).digest());
        }
        return new Uint8Array(crypto.subtle.digest('SHA-256', data));
    }

    // ─── PBKDF2 (HMAC-SHA256, custom XOR chain matching Kotlin) ─────────────
    function pbkdf2Hmac(keyBytes, salt, iterations) {
        if (nodeCrypto && nodeCrypto.createHmac) {
            var input = Buffer.alloc(salt.length + 4);
            Buffer.from(salt).copy(input, 0);
            input[salt.length] = 0;
            input[salt.length + 1] = 0;
            input[salt.length + 2] = 0;
            input[salt.length + 3] = 1;

            var hmac = nodeCrypto.createHmac('sha256', Buffer.from(keyBytes));
            hmac.update(input);
            var u = new Uint8Array(hmac.digest());
            var result = new Uint8Array(u);
            for (var i = 2; i <= iterations; i++) {
                hmac = nodeCrypto.createHmac('sha256', Buffer.from(keyBytes));
                hmac.update(Buffer.from(u));
                u = new Uint8Array(hmac.digest());
                for (var j = 0; j < result.length; j++) {
                    result[j] = result[j] ^ u[j];
                }
            }
            return result;
        }
        return (async function () {
            var cryptoKey = await crypto.subtle.importKey(
                'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
            );
            var input = new Uint8Array(salt.length + 4);
            input.set(new Uint8Array(salt), 0);
            input[salt.length + 3] = 1;
            var u = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, input));
            var result = new Uint8Array(u);
            for (var i = 2; i <= iterations; i++) {
                u = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, u));
                for (var j = 0; j < result.length; j++) result[j] = result[j] ^ u[j];
            }
            return result;
        })();
    }

    // ─── AES-CBC Decrypt ───────────────────────────────────────────────────
    function aesCbcDecrypt(ciphertext, key, iv) {
        if (nodeCrypto && nodeCrypto.createDecipheriv) {
            var decipher = nodeCrypto.createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv));
            var decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
            return decrypted.toString('utf-8');
        }
        return crypto.decryptAES(
            crypto.b64encode(String.fromCharCode.apply(null, ciphertext)),
            crypto.b64encode(String.fromCharCode.apply(null, key)),
            crypto.b64encode(String.fromCharCode.apply(null, iv)),
            { mode: 'cbc' }
        );
    }

    // ─── resolveMappings (same as Kotlin) ───────────────────────────────────
    async function resolveMappings(seed) {
        var e = seed;
        for (var o = 0; o < 3; o++) e = await sha256String(e + o.toString());
        var s = e;
        for (var o = 0; o < 3; o++) s = await sha256String(s + o.toString());

        return {
            videoField:     'vf_' + e.substring(0, 8),
            keyField:       'kf_' + e.substring(8, 16),
            ivField:        'ivf_' + e.substring(16, 24),
            containerName:  'cd_' + e.substring(24, 32),
            arrayName:      'ad_' + e.substring(32, 40),
            objectName:     'od_' + e.substring(40, 48),
            tokenField:     e.substring(48, 64) + '_' + e.substring(56, 64),
            keyFrag2Field:  s.substring(0, 16) + '_' + s.substring(16, 24)
        };
    }

    // ─── MiniWasmInterpreter (ported from Kotlin) ──────────────────────────
    function MiniWasmInterpreter(wasmBytes) {
        this.memory = new Uint8Array(65536);
        this.globals = new Int32Array(16);
        this.wasmBytes = wasmBytes;
    }

    MiniWasmInterpreter.prototype.readVarUint = function (offset) {
        var result = 0;
        var shift = 0;
        while (true) {
            var byte = this.wasmBytes[offset[0]++] & 0xff;
            result = result | ((byte & 0x7f) << shift);
            if ((byte & 0x80) === 0) break;
            shift += 7;
        }
        return result;
    };

    MiniWasmInterpreter.prototype.readVarSint = function (offset) {
        var result = 0;
        var shift = 0;
        var byte = 0;
        while (true) {
            byte = this.wasmBytes[offset[0]++] & 0xff;
            result = result | ((byte & 0x7f) << shift);
            shift += 7;
            if ((byte & 0x80) === 0) break;
        }
        if (shift < 32 && (byte & 0x40) !== 0) {
            result = result | (-1 << shift);
        }
        return result;
    };

    MiniWasmInterpreter.prototype.parseWasm = function () {
        var offset = 8;
        var funcs = [];
        while (offset < this.wasmBytes.length) {
            var type = this.wasmBytes[offset++] & 0xff;
            var offsetRef = [offset];
            var size = this.readVarUint(offsetRef);
            offset = offsetRef[0];
            var end = offset + size;

            if (type === 10) { // Code section
                var funcCount = this.readVarUint(offsetRef);
                offset = offsetRef[0];
                for (var f = 0; f < funcCount; f++) {
                    var bodySize = this.readVarUint(offsetRef);
                    var bodyStart = offsetRef[0];
                    var body = this.wasmBytes.slice(bodyStart, bodyStart + bodySize);
                    funcs.push(body);
                    offsetRef[0] = bodyStart + bodySize;
                }
            } else if (type === 11) { // Data section
                var segCount = this.readVarUint(offsetRef);
                offset = offsetRef[0];
                for (var s = 0; s < segCount; s++) {
                    var flags = this.readVarUint(offsetRef);
                    if (flags === 0) { // Active segment
                        offsetRef[0]++; // skip i32.const opcode (0x41)
                        var memOffset = this.readVarSint(offsetRef);
                        offsetRef[0]++; // skip end opcode (0x0b)
                        var dataLen = this.readVarUint(offsetRef);
                        for (var d = 0; d < dataLen; d++) {
                            this.memory[memOffset + d] = this.wasmBytes[offsetRef[0] + d];
                        }
                        offsetRef[0] += dataLen;
                    }
                }
            }
            offset = end;
        }
        return funcs;
    };

    MiniWasmInterpreter.prototype.executeWasm = function (funcs, frag1, frag2, keyPart, seedInt) {
        var k = frag1.length;
        var p = 1000;
        var v = p + k;
        var tOffset = v + k;
        var i = tOffset + k;

        for (var idx = 0; idx < k; idx++) {
            this.memory[p + idx] = frag1[idx];
            this.memory[v + idx] = frag2[idx];
            this.memory[tOffset + idx] = keyPart[idx];
        }

        this.globals[0] = seedInt;

        this.runFunc(funcs[0], [seedInt]);
        this.runFunc(funcs[1], [p, v, tOffset, i, k]);

        return this.memory.slice(i, i + k);
    };

    MiniWasmInterpreter.prototype.runFunc = function (body, args) {
        var offsetRef = [0];
        var localDeclCount = this.readVarUintFromBuf(body, offsetRef);
        var locals = [];
        for (var a = 0; a < args.length; a++) locals.push(args[a]);
        for (var d = 0; d < localDeclCount; d++) {
            var count = this.readVarUintFromBuf(body, offsetRef);
            offsetRef[0]++; // skip type byte (0x7f)
            for (var c = 0; c < count; c++) locals.push(0);
        }

        var code = body.slice(offsetRef[0], body.length);
        var stack = [];
        var pc = 0;

        // Build jump table
        var jumps = {};
        var blockStack = [];
        var tpc = 0;
        while (tpc < code.length) {
            var op = code[tpc] & 0xff;
            if (op === 0x02 || op === 0x03) { // block or loop
                blockStack.push({ op: op, pc: tpc });
                tpc += 2;
            } else if (op === 0x0b) { // end
                if (blockStack.length > 0) {
                    var entry = blockStack.pop();
                    jumps[entry.pc] = tpc;
                    jumps[tpc] = entry.pc;
                }
                tpc++;
            } else if (op === 0x0c || op === 0x0d) { // br or br_if
                tpc++;
                var ref = [tpc];
                this.readVarUintFromBuf(code, ref);
                tpc = ref[0];
            } else if (op === 0x20 || op === 0x21 || op === 0x23 || op === 0x24) {
                tpc++;
                var ref = [tpc];
                this.readVarUintFromBuf(code, ref);
                tpc = ref[0];
            } else if (op === 0x41) {
                tpc++;
                var ref = [tpc];
                this.readVarSintFromBuf(code, ref);
                tpc = ref[0];
            } else if (op === 0x2d || op === 0x3a) {
                tpc += 3;
            } else {
                tpc++;
            }
        }

        var activeBlocks = [];
        while (pc < code.length) {
            var op = code[pc] & 0xff;

            if (op === 0x02) { // block
                activeBlocks.push({ op: op, pc: pc, end: jumps[pc] || 0 });
                pc += 2;
            } else if (op === 0x03) { // loop
                activeBlocks.push({ op: op, pc: pc, end: jumps[pc] || 0 });
                pc += 2;
            } else if (op === 0x0b) { // end
                if (activeBlocks.length > 0) activeBlocks.pop();
                pc++;
            } else if (op === 0x0c) { // br
                pc++;
                var ref = [pc];
                var depth = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                var target = activeBlocks[activeBlocks.length - 1 - depth];
                if (target.op === 0x02) { // block
                    pc = target.end + 1;
                    for (var x = 0; x < depth + 1; x++) activeBlocks.pop();
                } else { // loop
                    pc = target.pc + 2;
                    for (var x = 0; x < depth; x++) activeBlocks.pop();
                }
            } else if (op === 0x0d) { // br_if
                pc++;
                var ref = [pc];
                var depth = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                var cond = stack.pop();
                if (cond !== 0) {
                    var target = activeBlocks[activeBlocks.length - 1 - depth];
                    if (target.op === 0x02) { // block
                        pc = target.end + 1;
                        for (var x = 0; x < depth + 1; x++) activeBlocks.pop();
                    } else { // loop
                        pc = target.pc + 2;
                        for (var x = 0; x < depth; x++) activeBlocks.pop();
                    }
                }
            } else if (op === 0x20) { // local.get
                pc++;
                var ref = [pc];
                var idx = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                stack.push(locals[idx]);
            } else if (op === 0x21) { // local.set
                pc++;
                var ref = [pc];
                var idx = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                locals[idx] = stack.pop();
            } else if (op === 0x23) { // global.get
                pc++;
                var ref = [pc];
                var idx = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                stack.push(this.globals[idx]);
            } else if (op === 0x24) { // global.set
                pc++;
                var ref = [pc];
                var idx = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                this.globals[idx] = stack.pop();
            } else if (op === 0x41) { // i32.const
                pc++;
                var ref = [pc];
                var valConst = this.readVarSintFromBuf(code, ref);
                pc = ref[0];
                stack.push(valConst);
            } else if (op === 0x2d) { // i32.load8_u
                pc += 3;
                var addr = stack.pop();
                stack.push(this.memory[addr] & 0xff);
            } else if (op === 0x3a) { // i32.store8
                pc += 3;
                var valStore = stack.pop();
                var addr = stack.pop();
                this.memory[addr] = valStore & 0xff;
            } else if (op === 0x3b) { // i32.store16
                pc += 3;
                var valStore = stack.pop();
                var addr = stack.pop();
                this.memory[addr] = valStore & 0xff;
                this.memory[addr + 1] = (valStore >>> 8) & 0xff;
            } else if (op === 0x6a) { // i32.add
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a + b);
            } else if (op === 0x6b) { // i32.sub
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a - b);
            } else if (op === 0x6c) { // i32.mul
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a * b);
            } else if (op === 0x73) { // i32.xor
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a ^ b);
            } else if (op === 0x74) { // i32.shl
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a << (b & 31));
            } else if (op === 0x75) { // i32.shr_s
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a >> (b & 31));
            } else if (op === 0x76) { // i32.shr_u
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push((a >>> 0) >> (b & 31));
            } else if (op === 0x72) { // i32.or
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a | b);
            } else if (op === 0x71) { // i32.and
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a & b);
            } else if (op === 0x6d) { // i32.div_u
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) / (b >>> 0)) | 0);
            } else if (op === 0x70) { // i32.rem_u
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) % (b >>> 0)) | 0);
            } else if (op === 0x4f) { // i32.ge_u
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) >= (b >>> 0)) ? 1 : 0);
            } else if (op === 0x45) { // i32.eqz
                pc++;
                var a = stack.pop();
                stack.push((a === 0) ? 1 : 0);
            } else if (op === 0x46) { // i32.eq
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push((a === b) ? 1 : 0);
            } else if (op === 0x47) { // i32.ne
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push((a !== b) ? 1 : 0);
            } else if (op === 0x49) { // i32.lt_u
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) < (b >>> 0)) ? 1 : 0);
            } else if (op === 0x4b) { // i32.gt_u
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) > (b >>> 0)) ? 1 : 0);
            } else if (op === 0x4d) { // i32.le_u
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) <= (b >>> 0)) ? 1 : 0);
            } else if (op === 0x0f) { // return
                pc++;
            } else {
                throw new Error('Unsupported opcode: 0x' + op.toString(16));
            }
        }
        return stack.length > 0 ? stack[stack.length - 1] : 0;
    };

    MiniWasmInterpreter.prototype.readVarUintFromBuf = function (buf, offset) {
        var result = 0;
        var shift = 0;
        while (true) {
            var byte = buf[offset[0]++] & 0xff;
            result = result | ((byte & 0x7f) << shift);
            if ((byte & 0x80) === 0) break;
            shift += 7;
        }
        return result;
    };

    MiniWasmInterpreter.prototype.readVarSintFromBuf = function (buf, offset) {
        var result = 0;
        var shift = 0;
        var byte = 0;
        while (true) {
            byte = buf[offset[0]++] & 0xff;
            result = result | ((byte & 0x7f) << shift);
            shift += 7;
            if ((byte & 0x80) === 0) break;
        }
        if (shift < 32 && (byte & 0x40) !== 0) {
            result = result | (-1 << shift);
        }
        return result;
    };

    // ─── buildPlaybackHeaders ───────────────────────────────────────────────
    function buildPlaybackHeaders(videoUrl, embedUrl) {
        var origin = 'https://fetch.flixcloud.cc';
        try {
            var u = new URL(videoUrl);
            origin = u.protocol + '//' + u.host;
        } catch (_) {}
        return {
            'Accept': '*/*',
            'Origin': origin,
            'Referer': embedUrl
        };
    }

    // ─── Regex helper for embed HTML ───────────────────────────────────────
    function regexFind1(html, pattern) {
        var m = html.match(pattern);
        return m ? m[1] : null;
    }

    // ─── getHome ────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var [topRes, latestRes] = await Promise.all([
                http_get(BASE_URL + '/api/v1/top/anime?period=week&limit=20', HEADERS),
                http_get(BASE_URL + '/api/v1/home/latest-aired?limit=20', HEADERS)
            ]);

            var topData = parseJson(topRes);
            var latestData = parseJson(latestRes);

            var result = {};

            if (topData && topData.data && topData.data.length) {
                result['Trending'] = topData.data.map(function (item) {
                    return new MultimediaItem({
                        title:     item.title && (item.title.english || item.title.user_preferred || item.title.romaji) || 'Unknown',
                        url:       String(item.anime_id),
                        posterUrl: item.cover_image && (item.cover_image.large || item.cover_image.medium) || '',
                        type:      'anime'
                    });
                });
            }

            if (latestData && latestData.data && latestData.data.length) {
                result['Latest Aired'] = latestData.data.map(function (item) {
                    return new MultimediaItem({
                        title:     item.title && (item.title.english || item.title.user_preferred || item.title.romaji) || 'Unknown',
                        url:       String(item.anime_id),
                        posterUrl: item.cover_image && (item.cover_image.large || item.cover_image.medium) || '',
                        type:      'anime'
                    });
                });
            }

            if (!Object.keys(result).length) {
                return cb({ success: false, error: 'No content found on homepage.' });
            }

            cb({ success: true, data: result });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── search ─────────────────────────────────────────────────────────────
    async function search(query, cb) {
        try {
            var encoded = encodeURIComponent(query);
            var res = await http_get(BASE_URL + '/api/v1/search?q=' + encoded + '&limit=20&offset=0', HEADERS);
            var data = parseJson(res);

            var items = (data && data.results || []).map(function (item) {
                return new MultimediaItem({
                    title:     item.title && (item.title.english || item.title.user_preferred || item.title.romaji) || 'Unknown',
                    url:       String(item.anime_id),
                    posterUrl: item.cover_image && (item.cover_image.large || item.cover_image.medium) || '',
                    type:      'anime'
                });
            });

            cb({ success: true, data: items });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── load ───────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var animeId = url;
            var [detailRes, episodesRes] = await Promise.all([
                http_get(BASE_URL + '/api/v1/anime/' + animeId, HEADERS),
                http_get(BASE_URL + '/api/v1/anime/' + animeId + '/episodes?limit=2000', HEADERS)
            ]);

            var detail = parseJson(detailRes);
            var epsRaw = parseJson(episodesRes);

            if (!detail) return cb({ success: false, error: 'Failed to load anime details.' });

            var description = (detail.description || '')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]*>/g, '')
                .trim();

            var status = 'other';
            if (detail.status) {
                var s = detail.status.toLowerCase();
                if (s === 'finished') status = 'completed';
                else if (s === 'releasing') status = 'ongoing';
            }

            var genres = detail.genres || [];

            // Parse episodes
            var epList = [];
            if (Array.isArray(epsRaw)) {
                epList = epsRaw;
            } else if (epsRaw && Array.isArray(epsRaw.data)) {
                epList = epsRaw.data;
            }

            var episodes = epList.map(function (ep) {
                var numStr = (ep.episode_number % 1 === 0)
                    ? Math.floor(ep.episode_number).toString()
                    : String(ep.episode_number);
                var name = (ep.title && ep.title.trim()) || ('Episode ' + numStr);
                return new Episode({
                    name:      name,
                    url:       animeId + '?ep=' + ep.episode_number,
                    season:    1,
                    episode:   ep.episode_number,
                    dubStatus: 'subbed'
                });
            }).reverse(); // Ascending order

            // Build syncData with anilist_id if available
            var syncData = undefined;
            if (detail.anilist_id) {
                syncData = { anilist: String(detail.anilist_id) };
            }

            // Title may be an object { english, romaji, user_preferred } or a string
            var animeTitle = 'Unknown';
            if (detail.title) {
                if (typeof detail.title === 'string') {
                    animeTitle = detail.title;
                } else if (typeof detail.title === 'object') {
                    animeTitle = detail.title.english || detail.title.user_preferred || detail.title.romaji || 'Unknown';
                }
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title:       animeTitle,
                    url:         animeId,
                    posterUrl:   detail.cover_image && (detail.cover_image.large || detail.cover_image.medium) || '',
                    type:        'anime',
                    status:      status,
                    description: description,
                    tags:        genres,
                    episodes:    episodes,
                    syncData:    syncData
                })
            });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── loadStreams ────────────────────────────────────────────────────────
    async function loadStreams(url, cb) {
        try {
            var requestUrl = url;
            var slug = requestUrl.split('?')[0];
            var epNumStr = requestUrl.indexOf('?ep=') !== -1
                ? requestUrl.split('?ep=')[1]
                : requestUrl.split('/').pop();

            // 1. Fetch anime details to get anilist_id
            var watchRes = await http_get(BASE_URL + '/api/v1/anime/' + slug, HEADERS);
            var watchData = parseJson(watchRes);
            if (!watchData) return cb({ success: false, error: 'Failed to fetch anime details.' });

            var anilistId = watchData.anilist_id || 0;

            // Try extracting from cover image URL if not in response
            if (!anilistId) {
                var coverUrls = [
                    watchData.cover_image && watchData.cover_image.extra_large,
                    watchData.cover_image && watchData.cover_image.large,
                    watchData.cover_image && watchData.cover_image.medium
                ];
                for (var ci = 0; ci < coverUrls.length; ci++) {
                    var coverUrl = coverUrls[ci];
                    if (coverUrl) {
                        var m = coverUrl.match(/\/bx(\d+)-/);
                        if (m) { anilistId = parseInt(m[1], 10); break; }
                    }
                }
            }

            if (!anilistId) return cb({ success: false, error: 'Could not find anilist_id.' });

            // 2. Fetch Flix API for servers
            var flixHeaders = Object.assign({}, HEADERS, {
                'Referer': BASE_URL + '/watch/' + slug + '?ep=' + epNumStr
            });
            var flixRes = await http_get(BASE_URL + '/api/flix/' + anilistId + '/' + epNumStr, flixHeaders);
            var flixData = parseJson(flixRes);

            if (!flixData || !flixData.servers || !flixData.servers.length) {
                return cb({ success: false, error: 'No servers found.' });
            }

            // Deduplicate servers by dataLink
            var servers = [];
            flixData.servers.forEach(function (server) {
                var exists = servers.some(function (s) { return s.dataLink === server.dataLink; });
                if (!exists) servers.push(server);
            });

            // 3. Resolve each server in parallel
            var allStreams = [];

            var tasks = servers.map(async function (server) {
                try {
                    var embedReferer = BASE_URL + '/watch/' + slug + '?ep=' + epNumStr;
                    var embedRes = await http_get(server.dataLink, Object.assign({}, HEADERS, { 'Referer': embedReferer }));
                    var embedHtml = getBody(embedRes);

                    var seed = regexFind1(embedHtml, /obfuscation_seed\s*:\s*"([^"]+)"/);
                    if (!seed) throw new Error('obfuscation_seed not found in embed (' + server.serverName + ')');

                    var wPayload = regexFind1(embedHtml, /w_payload\s*:\s*"([^"]+)"/);
                    if (!wPayload) throw new Error('w_payload not found in embed (' + server.serverName + ')');

                    var mappings = await resolveMappings(seed);

                    var w = regexFind1(embedHtml, new RegExp('"?' + mappings.tokenField + '"?\\s*:\\s*"([^"]+)"'));
                    if (!w) throw new Error('tokenField not found — seed=' + seed);

                    var frag2B64 = regexFind1(embedHtml, new RegExp('"?' + mappings.keyFrag2Field + '"?\\s*:\\s*"([^"]+)"'));
                    if (!frag2B64) throw new Error('keyFrag2Field not found');

                    // 4. Fetch session token from flixcloud.cc
                    var m3u8ApiUrl = 'https://flixcloud.cc/api/m3u8/' + w;
                    var tokenHeaders = {
                        'Referer': server.dataLink,
                        'Origin': 'https://flixcloud.cc'
                    };
                    var tokenRes = await http_get(m3u8ApiUrl, tokenHeaders);
                    var tokenBody = getBody(tokenRes);
                    var tokenJson = parseJson(tokenBody);
                    if (!tokenJson) throw new Error('Failed to parse m3u8 token response');

                    var kField = (await sha256String(w + 'vid')).substring(0, 10);
                    var pField = (await sha256String(w + 'key')).substring(0, 10);

                    var v = tokenJson[kField];
                    var t = tokenJson[pField];
                    if (!v) throw new Error('kField (' + kField + ') not in m3u8 response');
                    if (!t) throw new Error('pField (' + pField + ') not in m3u8 response');

                    // 5. Get remaining crypto fragments from embed
                    var frag1B64 = regexFind1(embedHtml, new RegExp('"?' + mappings.keyField + '"?\\s*:\\s*"([^"]+)"'));
                    if (!frag1B64) throw new Error('keyField not found');

                    var ivB64 = regexFind1(embedHtml, new RegExp('"?' + mappings.ivField + '"?\\s*:\\s*"([^"]+)"'));
                    if (!ivB64) throw new Error('ivField not found');

                    // 6. WASM interpretation
                    var frag1Bytes = base64ToBytes(frag1B64);
                    var frag2Bytes = base64ToBytes(frag2B64);
                    var keyPartBytes = base64ToBytes(t);
                    var seedInt = parseInt(seed.substring(0, 8), 16);

                    var wasmBytes = base64ToBytes(wPayload);
                    var interpreter = new MiniWasmInterpreter(wasmBytes);
                    var funcs = interpreter.parseWasm();
                    var derivedBaseKey = interpreter.executeWasm(funcs, frag1Bytes, frag2Bytes, keyPartBytes, seedInt);

                    // 7. PBKDF2 + XOR + SHA-256 → AES key
                    var salt = stringToBytes(seed);
                    var pbkdf2Result = await pbkdf2Hmac(derivedBaseKey, salt, 1000);

                    var finalKey = new Uint8Array(32);
                    for (var idx = 0; idx < 32; idx++) {
                        finalKey[idx] = pbkdf2Result[idx] ^ seed.charCodeAt(idx % seed.length);
                    }

                    var aesKey = await sha256Bytes(finalKey);
                    var iv = base64ToBytes(ivB64);
                    var ciphertext = base64ToBytes(v);

                    // 8. AES-CBC decrypt → m3u8 URL
                    var decryptedUrl = await aesCbcDecrypt(ciphertext, aesKey, iv);

                    // 9. Parse m3u8 master playlist for quality variants
                    var playHeaders = buildPlaybackHeaders(decryptedUrl, server.dataLink);
                    var m3u8Res = await http_get(decryptedUrl, playHeaders);
                    var m3u8Body = getBody(m3u8Res);

                    var streams = [];
                    // Try parsing m3u8 master playlist for variants
                    var lines = m3u8Body.split('\n');
                    var baseM3u8 = decryptedUrl.substring(0, decryptedUrl.lastIndexOf('/') + 1);
                    for (var li = 0; li < lines.length; li++) {
                        var line = lines[li].trim();
                        if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
                            var nextLine = (li + 1 < lines.length) ? lines[li + 1].trim() : '';
                            if (!nextLine || nextLine.charAt(0) === '#') continue;

                            var bwMatch = line.match(/BANDWIDTH=(\d+)/);
                            var resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                            var nameMatch = line.match(/NAME="([^"]*)"/);

                            var quality = (nameMatch && nameMatch[1]) || (resMatch && resMatch[1]) || 'Default';
                            var variantUrl = nextLine;
                            if (!variantUrl.match(/^https?:\/\//i)) {
                                variantUrl = baseM3u8 + variantUrl;
                            }
                            streams.push(new StreamResult({
                                url:     variantUrl,
                                quality: quality,
                                source:  server.serverName + ' (' + server.dataType + ')',
                                headers: playHeaders
                            }));
                        }
                    }

                    // If no variants found, return master URL directly
                    if (streams.length === 0) {
                        streams.push(new StreamResult({
                            url:     decryptedUrl,
                            quality: 'Default',
                            source:  server.serverName + ' (' + server.dataType + ')',
                            headers: playHeaders
                        }));
                    }

                    return streams;
                } catch (_) {
                    return [];
                }
            });

            var results = await Promise.all(tasks);
            results.forEach(function (streams) {
                allStreams = allStreams.concat(streams);
            });

            if (!allStreams.length) {
                return cb({ success: false, error: 'No stream links found.' });
            }

            cb({ success: true, data: allStreams });
        } catch (e) { cb({ success: false, error: String(e) }); }
    }

    // ─── Expose ─────────────────────────────────────────────────────────────
    globalThis.getHome    = getHome;
    globalThis.search     = search;
    globalThis.load       = load;
    globalThis.loadStreams = loadStreams;

})();
