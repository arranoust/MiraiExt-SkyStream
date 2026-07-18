(function () {

    // ─── Config ──────────────────────────────────────────────────────────────
    var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

    function headers(extra) {
        var h = {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Referer': manifest.baseUrl + '/'
        };
        if (extra) { for (var k in extra) h[k] = extra[k]; }
        return h;
    }

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

    function regexFind1(html, pattern) {
        var m = html.match(pattern);
        return m ? m[1] : null;
    }

    function titleFromObj(t) {
        if (!t) return 'Unknown';
        if (typeof t === 'string') return t;
        return t.english || t.user_preferred || t.romaji || 'Unknown';
    }

    function scoreToDecimal(s) {
        return (typeof s === 'number' && s > 0) ? Math.round(s) / 10 : undefined;
    }

    function formatDate(d) {
        if (!d) return undefined;
        var dt = new Date(d);
        if (isNaN(dt.getTime())) return undefined;
        return dt.getFullYear() + '-' +
            String(dt.getMonth() + 1).padStart(2, '0') + '-' +
            String(dt.getDate()).padStart(2, '0');
    }

    // ─── HLS helpers ───────────────────────────────────────────────────────
    function resolveUrl(base, relative) {
        if (!relative) return base;
        if (relative.indexOf('http') === 0) return relative;
        if (relative.indexOf('//') === 0) return 'https:' + relative;
        if (relative.indexOf('/') === 0) {
            var end = base.indexOf('://') + 3;
            var hostEnd = base.indexOf('/', end);
            if (hostEnd === -1) hostEnd = base.length;
            return base.slice(0, hostEnd) + relative;
        }
        var slash = base.lastIndexOf('/');
        return (slash > 8 ? base.slice(0, slash + 1) : base + '/') + relative;
    }

    // Parse a master m3u8 into { variants, mediaLines }.
    // mediaLines: #EXT-X-MEDIA lines with URIs resolved to absolute.
    // infLine: original #EXT-X-STREAM-INF line preserved for reconstruction.
    function parseHlsMaster(content, baseUrl) {
        if (!content || content.indexOf('#EXTM3U') === -1) return null;
        var variants  = [];
        var mediaLines = [];
        var lines = content.split('\n');
        var inf   = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (line.indexOf('#EXT-X-MEDIA') === 0) {
                var resolved = line.replace(/URI="([^"]+)"/, function (_, uri) {
                    return 'URI="' + resolveUrl(baseUrl, uri) + '"';
                });
                mediaLines.push(resolved);
            } else if (line.indexOf('#EXT-X-STREAM-INF') === 0) {
                var resM = line.match(/RESOLUTION=(\d+)x(\d+)/);
                var bwM  = line.match(/[^-]BANDWIDTH=(\d+)\b/);
                inf = {
                    height:    resM ? parseInt(resM[2], 10) : 0,
                    bandwidth: bwM  ? parseInt(bwM[1], 10)  : 0,
                    infLine:   line
                };
            } else if (line.indexOf('#') === 0) {
                continue;
            } else if (inf) {
                var vUrl = resolveUrl(baseUrl, line);
                variants.push({
                    url:       vUrl,
                    height:    inf.height,
                    bandwidth: inf.bandwidth,
                    infLine:   inf.infLine
                });
                inf = null;
            }
        }

        variants.sort(function (a, b) { return b.height - a.height; });
        return variants.length > 0 ? { variants: variants, mediaLines: mediaLines } : null;
    }

    // Reconstruct a mini master playlist for a single variant that includes audio groups.
    function buildMiniMaster(variant, mediaLines) {
        var l = ['#EXTM3U', '#EXT-X-VERSION:3'];
        mediaLines.forEach(function (ml) { l.push(ml); });
        l.push(variant.infLine);
        l.push(variant.url);
        return 'magic_m3u8:' + btoa(l.join('\n'));
    }

    // Rewrite an m3u8 playlist: make all URLs absolute and wrap with MAGIC_PROXY.
    // Handles variant URLs, segment URLs, and #EXT-X-MEDIA URIs.
    function proxyM3u8Content(content, baseUrl) {
        var out = [];
        var pendingInf = null;

        for (var i = 0; i < content.length; i++) {
            var line = content[i];

            // Proxy URI= in #EXT-X-MEDIA tags
            if (line.indexOf('#EXT-X-MEDIA') === 0) {
                line = line.replace(/URI="([^"]+)"/, function (_, uri) {
                    var abs = resolveUrl(baseUrl, uri);
                    if (abs.indexOf('MAGIC_PROXY') === 0) return _;
                    return 'URI="MAGIC_PROXY_v1' + btoa(abs) + '"';
                });
                out.push(line);
                continue;
            }

            // Preserve #EXT-X-STREAM-INF and tag lines as-is
            if (line.indexOf('#EXT-X-STREAM-INF') === 0) { pendingInf = line; out.push(line); continue; }
            if (line.indexOf('#EXT') === 0 || line.indexOf('#') === 0) { out.push(line); continue; }

            // Blank line
            if (!line.trim()) { out.push(line); continue; }

            // URL line (after an inf or segment tag) — wrap with MAGIC_PROXY
            var abs = resolveUrl(baseUrl, line);
            if (abs.indexOf('MAGIC_PROXY') !== 0) abs = 'MAGIC_PROXY_v1' + btoa(abs);
            out.push(abs);
            pendingInf = null;
        }

        return out.join('\n');
    }

    // ─── Crypto (via __crypto__) ────────────────────────────────────────────
    var nodeCrypto;
    try { nodeCrypto = __crypto__; } catch (_) { nodeCrypto = null; }

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

    // ─── WASM field mappings (from obfuscation_seed) ────────────────────────
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

    // ─── MiniWasmInterpreter ────────────────────────────────────────────────
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

            if (type === 10) {
                var funcCount = this.readVarUint(offsetRef);
                offset = offsetRef[0];
                for (var f = 0; f < funcCount; f++) {
                    var bodySize = this.readVarUint(offsetRef);
                    var bodyStart = offsetRef[0];
                    var body = this.wasmBytes.slice(bodyStart, bodyStart + bodySize);
                    funcs.push(body);
                    offsetRef[0] = bodyStart + bodySize;
                }
            } else if (type === 11) {
                var segCount = this.readVarUint(offsetRef);
                offset = offsetRef[0];
                for (var s = 0; s < segCount; s++) {
                    var flags = this.readVarUint(offsetRef);
                    if (flags === 0) {
                        offsetRef[0]++;
                        var memOffset = this.readVarSint(offsetRef);
                        offsetRef[0]++;
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
            offsetRef[0]++;
            for (var c = 0; c < count; c++) locals.push(0);
        }

        var code = body.slice(offsetRef[0], body.length);
        var stack = [];
        var pc = 0;

        var jumps = {};
        var blockStack = [];
        var tpc = 0;
        while (tpc < code.length) {
            var op = code[tpc] & 0xff;
            if (op === 0x02 || op === 0x03) {
                blockStack.push({ op: op, pc: tpc });
                tpc += 2;
            } else if (op === 0x0b) {
                if (blockStack.length > 0) {
                    var entry = blockStack.pop();
                    jumps[entry.pc] = tpc;
                    jumps[tpc] = entry.pc;
                }
                tpc++;
            } else if (op === 0x0c || op === 0x0d) {
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

            if (op === 0x02) {
                activeBlocks.push({ op: op, pc: pc, end: jumps[pc] || 0 });
                pc += 2;
            } else if (op === 0x03) {
                activeBlocks.push({ op: op, pc: pc, end: jumps[pc] || 0 });
                pc += 2;
            } else if (op === 0x0b) {
                if (activeBlocks.length > 0) activeBlocks.pop();
                pc++;
            } else if (op === 0x0c) {
                pc++;
                var ref = [pc];
                var depth = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                var target = activeBlocks[activeBlocks.length - 1 - depth];
                if (target.op === 0x02) {
                    pc = target.end + 1;
                    for (var x = 0; x < depth + 1; x++) activeBlocks.pop();
                } else {
                    pc = target.pc + 2;
                    for (var x = 0; x < depth; x++) activeBlocks.pop();
                }
            } else if (op === 0x0d) {
                pc++;
                var ref = [pc];
                var depth = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                var cond = stack.pop();
                if (cond !== 0) {
                    var target = activeBlocks[activeBlocks.length - 1 - depth];
                    if (target.op === 0x02) {
                        pc = target.end + 1;
                        for (var x = 0; x < depth + 1; x++) activeBlocks.pop();
                    } else {
                        pc = target.pc + 2;
                        for (var x = 0; x < depth; x++) activeBlocks.pop();
                    }
                }
            } else if (op === 0x20) {
                pc++;
                var ref = [pc];
                var idx = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                stack.push(locals[idx]);
            } else if (op === 0x21) {
                pc++;
                var ref = [pc];
                var idx = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                locals[idx] = stack.pop();
            } else if (op === 0x23) {
                pc++;
                var ref = [pc];
                var idx = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                stack.push(this.globals[idx]);
            } else if (op === 0x24) {
                pc++;
                var ref = [pc];
                var idx = this.readVarUintFromBuf(code, ref);
                pc = ref[0];
                this.globals[idx] = stack.pop();
            } else if (op === 0x41) {
                pc++;
                var ref = [pc];
                var valConst = this.readVarSintFromBuf(code, ref);
                pc = ref[0];
                stack.push(valConst);
            } else if (op === 0x2d) {
                pc += 3;
                var addr = stack.pop();
                stack.push(this.memory[addr] & 0xff);
            } else if (op === 0x3a) {
                pc += 3;
                var valStore = stack.pop();
                var addr = stack.pop();
                this.memory[addr] = valStore & 0xff;
            } else if (op === 0x3b) {
                pc += 3;
                var valStore = stack.pop();
                var addr = stack.pop();
                this.memory[addr] = valStore & 0xff;
                this.memory[addr + 1] = (valStore >>> 8) & 0xff;
            } else if (op === 0x6a) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a + b);
            } else if (op === 0x6b) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a - b);
            } else if (op === 0x6c) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a * b);
            } else if (op === 0x73) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a ^ b);
            } else if (op === 0x74) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a << (b & 31));
            } else if (op === 0x75) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a >> (b & 31));
            } else if (op === 0x76) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push((a >>> 0) >> (b & 31));
            } else if (op === 0x72) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a | b);
            } else if (op === 0x71) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(a & b);
            } else if (op === 0x6d) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) / (b >>> 0)) | 0);
            } else if (op === 0x70) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) % (b >>> 0)) | 0);
            } else if (op === 0x4f) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) >= (b >>> 0)) ? 1 : 0);
            } else if (op === 0x45) {
                pc++;
                var a = stack.pop();
                stack.push((a === 0) ? 1 : 0);
            } else if (op === 0x46) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push((a === b) ? 1 : 0);
            } else if (op === 0x47) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push((a !== b) ? 1 : 0);
            } else if (op === 0x49) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) < (b >>> 0)) ? 1 : 0);
            } else if (op === 0x4b) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) > (b >>> 0)) ? 1 : 0);
            } else if (op === 0x4d) {
                pc++;
                var b = stack.pop();
                var a = stack.pop();
                stack.push(((a >>> 0) <= (b >>> 0)) ? 1 : 0);
            } else if (op === 0x0f) {
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

    // ─── getHome ────────────────────────────────────────────────────────────
    async function getHome(cb) {
        try {
            var [topRes, latestRes] = await Promise.all([
                http_get(manifest.baseUrl + '/api/v1/top/anime?period=week&limit=20', headers()),
                http_get(manifest.baseUrl + '/api/v1/home/latest-aired?limit=20', headers())
            ]);

            var topData = parseJson(topRes);
            var latestData = parseJson(latestRes);
            var result = {};

            if (topData && topData.data && topData.data.length) {
                result['Trending'] = topData.data.map(function (item) {
                    return new MultimediaItem({
                        title:     titleFromObj(item.title),
                        url:       String(item.anime_id),
                        posterUrl: item.cover_image && (item.cover_image.large || item.cover_image.medium) || '',
                        bannerUrl: item.banner_image || '',
                        type:      'anime',
                        score:     scoreToDecimal(item.average_score),
                        year:      item.season_year || undefined,
                        isAdult:   item.is_adult || false
                    });
                });
            }

            if (latestData && latestData.data && latestData.data.length) {
                result['Latest Aired'] = latestData.data.map(function (item) {
                    return new MultimediaItem({
                        title:     titleFromObj(item.title),
                        url:       String(item.anime_id),
                        posterUrl: item.cover_image && (item.cover_image.large || item.cover_image.medium) || '',
                        bannerUrl: item.banner_image || '',
                        type:      'anime',
                        score:     scoreToDecimal(item.average_score),
                        year:      item.season_year || undefined,
                        isAdult:   item.is_adult || false
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
    async function search(query, pageOrCb, cb) {
        var page, callback;
        if (typeof pageOrCb === 'function') {
            page = 1;
            callback = pageOrCb;
        } else {
            page = pageOrCb || 1;
            callback = cb;
        }
        try {
            var offset = (page - 1) * 20;
            var encoded = encodeURIComponent(query);
            var res = await http_get(manifest.baseUrl + '/api/v1/search?q=' + encoded + '&limit=20&offset=' + offset, headers());
            var data = parseJson(res);

            var items = (data && data.results || []).map(function (item) {
                return new MultimediaItem({
                    title:     titleFromObj(item.title),
                    url:       String(item.anime_id),
                    posterUrl: item.cover_image && (item.cover_image.large || item.cover_image.medium) || '',
                    bannerUrl: item.banner_image || '',
                    type:      'anime',
                    score:     scoreToDecimal(item.average_score),
                    year:      item.season_year || undefined,
                    isAdult:   item.is_adult || false
                });
            });

            callback({ success: true, data: items });
        } catch (e) { callback({ success: false, error: String(e) }); }
    }

    // ─── load ───────────────────────────────────────────────────────────────
    async function load(url, cb) {
        try {
            var animeId = url;
            var [detailRes, episodesRes] = await Promise.all([
                http_get(manifest.baseUrl + '/api/v1/anime/' + animeId, headers()),
                http_get(manifest.baseUrl + '/api/v1/anime/' + animeId + '/episodes?limit=2000', headers())
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
                    airDate:   formatDate(ep.aired),
                    runtime:   ep.duration || undefined,
                    dubStatus: 'subbed'
                });
            }).reverse();

            // syncData for anilist progress tracking
            var syncData = undefined;
            if (detail.anilist_id) {
                syncData = { anilist: String(detail.anilist_id) };
            }

            // nextAiring
            var nextAiring = undefined;
            if (detail.next_airing_episode && detail.next_airing_episode.airing_at) {
                nextAiring = new NextAiring({
                    episode:  detail.next_airing_episode.episode,
                    season:   1,
                    unixTime: Math.floor(new Date(detail.next_airing_episode.airing_at).getTime() / 1000)
                });
            }

            // cast from characters
            var cast = undefined;
            if (detail.characters && detail.characters.length) {
                cast = detail.characters.slice(0, 20).map(function (c) {
                    return new Actor({ name: c.name, role: c.role || '' });
                });
            }

            // trailer
            var trailers = undefined;
            if (detail.trailer && detail.trailer.id) {
                trailers = [new Trailer({ url: 'https://www.youtube.com/watch?v=' + detail.trailer.id })];
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title:         titleFromObj(detail.title),
                    url:           animeId,
                    posterUrl:     detail.cover_image && (detail.cover_image.large || detail.cover_image.medium) || '',
                    bannerUrl:     detail.banner_image || '',
                    type:          'anime',
                    status:        status,
                    description:   description,
                    tags:          detail.genres || [],
                    episodes:      episodes,
                    syncData:      syncData,
                    score:         scoreToDecimal(detail.average_score),
                    year:          detail.season_year || undefined,
                    duration:      detail.duration || undefined,
                    contentRating: detail.rating || undefined,
                    isAdult:       detail.is_adult || false,
                    nextAiring:    nextAiring,
                    cast:          cast,
                    trailers:      trailers
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
            var watchRes = await http_get(manifest.baseUrl + '/api/v1/anime/' + slug, headers());
            var watchData = parseJson(watchRes);
            if (!watchData) return cb({ success: false, error: 'Failed to fetch anime details.' });

            var anilistId = watchData.anilist_id || 0;

            // Fallback: extract from cover image URL
            if (!anilistId) {
                var coverUrls = [
                    watchData.cover_image && watchData.cover_image.extra_large,
                    watchData.cover_image && watchData.cover_image.large,
                    watchData.cover_image && watchData.cover_image.medium
                ];
                for (var ci = 0; ci < coverUrls.length; ci++) {
                    var m = (coverUrls[ci] || '').match(/\/bx(\d+)-/);
                    if (m) { anilistId = parseInt(m[1], 10); break; }
                }
            }

            if (!anilistId) return cb({ success: false, error: 'Could not find anilist_id.' });

            // 2. Fetch Flix API for servers
            var flixHeaders = headers({
                'Referer': manifest.baseUrl + '/watch/' + slug + '?ep=' + epNumStr
            });
            var flixRes = await http_get(manifest.baseUrl + '/api/flix/' + anilistId + '/' + epNumStr, flixHeaders);
            var flixData = parseJson(flixRes);

            if (!flixData || !flixData.servers || !flixData.servers.length) {
                return cb({ success: false, error: 'No servers found.' });
            }

            // Deduplicate by dataLink
            var servers = [];
            flixData.servers.forEach(function (server) {
                var exists = servers.some(function (s) { return s.dataLink === server.dataLink; });
                if (!exists) servers.push(server);
            });

            // 3. Resolve each server in parallel
            var allStreams = [];

            var tasks = servers.map(async function (server) {
                try {
                    var embedReferer = manifest.baseUrl + '/watch/' + slug + '?ep=' + epNumStr;
                    var embedRes = await http_get(server.dataLink, headers({ 'Referer': embedReferer }));
                    var embedHtml = getBody(embedRes);

                    var seed = regexFind1(embedHtml, /obfuscation_seed\s*:\s*"([^"]+)"/);
                    if (!seed) throw new Error('obfuscation_seed not found (' + server.serverName + ')');

                    var wPayload = regexFind1(embedHtml, /w_payload\s*:\s*"([^"]+)"/);
                    if (!wPayload) throw new Error('w_payload not found (' + server.serverName + ')');

                    var mappings = await resolveMappings(seed);

                    var w = regexFind1(embedHtml, new RegExp('"?' + mappings.tokenField + '"?\\s*:\\s*"([^"]+)"'));
                    if (!w) throw new Error('tokenField not found');

                    var frag2B64 = regexFind1(embedHtml, new RegExp('"?' + mappings.keyFrag2Field + '"?\\s*:\\s*"([^"]+)"'));
                    if (!frag2B64) throw new Error('keyFrag2Field not found');

                    // 4. Fetch session token from flixcloud.cc
                    var tokenRes = await http_get('https://flixcloud.cc/api/m3u8/' + w, {
                        'Referer': server.dataLink,
                        'Origin': 'https://flixcloud.cc'
                    });
                    var tokenJson = parseJson(tokenRes);
                    if (!tokenJson) throw new Error('Failed to parse m3u8 token response');

                    var kField = (await sha256String(w + 'vid')).substring(0, 10);
                    var pField = (await sha256String(w + 'key')).substring(0, 10);

                    var v = tokenJson[kField];
                    var t = tokenJson[pField];
                    if (!v) throw new Error('kField not in m3u8 response');
                    if (!t) throw new Error('pField not in m3u8 response');

                    // 5. Get remaining crypto fragments
                    var frag1B64 = regexFind1(embedHtml, new RegExp('"?' + mappings.keyField + '"?\\s*:\\s*"([^"]+)"'));
                    if (!frag1B64) throw new Error('keyField not found');

                    var ivB64 = regexFind1(embedHtml, new RegExp('"?' + mappings.ivField + '"?\\s*:\\s*"([^"]+)"'));
                    if (!ivB64) throw new Error('ivField not found');

                    // 6. WASM key derivation
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

                    // 9. Fetch m3u8 ourselves, parse, reconstruct with MAGIC_PROXY URLs
                    //    so the player gets absolute proxied URLs for every sub-request.
                    var flixOrigin = (function () {
                        try { var u = new URL(decryptedUrl); return u.protocol + '//' + u.host; } catch (_) { return ''; }
                    })();
                    var playHeaders = {
                        'User-Agent': UA,
                        'Accept':     '*/*',
                        'Referer':    server.dataLink,
                        'Origin':     flixOrigin
                    };

                    var masterRes = await http_get(decryptedUrl, playHeaders);
                    var masterBody = getBody(masterRes);
                    var master = masterBody ? parseHlsMaster(masterBody, decryptedUrl) : null;
                    var resLabel = server.serverName + ' (' + server.dataType + ')';

                    if (master && master.variants.length > 0) {
                        var streams = [];
                        for (var vi = 0; vi < master.variants.length; vi++) {
                            var v = master.variants[vi];
                            try {
                                var varRes = await http_get(v.url, playHeaders);
                                var varBody = getBody(varRes);
                                if (!varBody || varBody.indexOf('#EXTM3U') === -1) continue;

                                // Proxy every URL inside this variant playlist
                                var proxiedVar = proxyM3u8Content(varBody.split('\n'), v.url);

                                // Proxy media track URIs in the master
                                var mediaLines = master.mediaLines.map(function (ml) {
                                    return ml.replace(/URI="([^"]+)"/, function (_, uri) {
                                        if (uri.indexOf('MAGIC_PROXY') === 0) return _;
                                        var abs = resolveUrl(decryptedUrl, uri);
                                        return 'URI="MAGIC_PROXY_v1' + btoa(abs) + '"';
                                    });
                                });

                                var miniMaster = buildMiniMaster(
                                    { url: 'magic_m3u8:' + btoa(proxiedVar), infLine: v.infLine },
                                    mediaLines
                                );

                                streams.push(new StreamResult({
                                    url:     miniMaster,
                                    source:  resLabel
                                }));
                            } catch (_) {}
                        }

                        if (streams.length) return streams;
                    }

                    // Fallback: single MAGIC_PROXY URL
                    var magicUrl = 'MAGIC_PROXY_v1' + btoa(decryptedUrl);
                    return [new StreamResult({ url: magicUrl, source: resLabel })];
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
