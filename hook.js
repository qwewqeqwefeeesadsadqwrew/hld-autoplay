/* ============================================================
   hld patch shell  v2.1
   ------------------------------------------------------------
   This repo only ships our own code. Game assets and scripts are
   pulled from the official CDN at runtime and patched in memory
   right before they execute.

   Three locks live inside the official scripts:

   1) Domain lock
        if(!_0xXXXX){var _0xYYYY=new RegExp('...   ->   if(!1){...
      Present in all 13 bundle scripts and in the boot script
      s.92281.js. Left alone the page navigates to about:blank.

   2) Engine decrypt key
        SASE.decrypt(n, location.hostname)  ->  SASE.decrypt(n, 'static.zuiqiangyingyu.net')
      The config payloads are encrypted with the official hostname
      as the key, so the engine must see that exact string.

   3) Anti-devtools guard (FuckDevtool) in the boot script
        ...'threshold':0x64})['\x69\x6e\x69\x74']();...
      Only the call itself is dropped, the config object stays.
      Mobile address bars change the viewport size and can trip it.
      NOTE: the file contains four more ['\x69\x6e\x69\x74']() sites
      (a class method and real calls) - matching on the threshold
      anchor keeps them untouched. Matching them broke the script
      with "SyntaxError: Unexpected identifier".

   Patched scripts are cached in CacheStorage so a reload does not
   recompute anything. Bump CACHE_NAME whenever a rule changes.
   ============================================================ */
(function () {
  var CDN_PREFIX = 'https://static.zuiqiangyingyu.net/wb_webview/happylittledays/h5/';
  var TARGET_RE = /(\/assets\/[^\/]+\/index\.[0-9a-f]+\.js|\/s\.[0-9a-f]+\.js|\/cocos2d-js-min[a-z0-9.]*\.js)(\?|#|$)/;
  var ENGINE_RE = /\/cocos2d-js-min[a-z0-9.]*\.js(\?|#|$)/;
  var BOOT_RE = /\/s\.[0-9a-f]+\.js(\?|#|$)/;
  var CACHE_NAME = 'hld-patch-v3';
  var mem = Object.create(null);

  function isTarget(abs) {
    return abs.indexOf(CDN_PREFIX) === 0 && TARGET_RE.test(abs);
  }

  // ---- byte helpers ----
  function bytes(str) {
    var u = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 0xff;
    return u;
  }
  function startsWith(u8, i, needle) {
    if (i + needle.length > u8.length) return false;
    for (var k = 0; k < needle.length; k++) if (u8[i + k] !== needle[k]) return false;
    return true;
  }
  function isHex(b) { return (b >= 48 && b <= 57) || (b >= 97 && b <= 102); }

  var ONE = new Uint8Array([49]); // '1'

  // rule 3 anchor: the escaped "threshold" key + '0x64})' + the guard call
  var NEEDLE_GUARD = bytes("\\x74\\x68\\x72\\x65\\x73\\x68\\x6f\\x6c\\x64':0x64})['\\x69\\x6e\\x69\\x74']();");
  var GUARD_REPL = bytes("\\x74\\x68\\x72\\x65\\x73\\x68\\x6f\\x6c\\x64':0x64});");

  // rule 2 anchor
  var NEEDLE_HOSTKEY = bytes(',location.hostname)');
  var HOSTKEY_REPL = bytes(",'static.zuiqiangyingyu.net')");

  // ---- patch in place ----
  function patchBytes(u8, kind) { // kind: 'engine' | 'boot' | 'bundle'
    var n = u8.length, i = 0, last = 0, found = 0, parts = null;

    function begin() { if (!parts) parts = []; }
    function cut(end) { begin(); parts.push(u8.subarray(last, end)); }

    while (i < n) {
      // rule 2: engine decrypt key
      if (kind === 'engine' && startsWith(u8, i, NEEDLE_HOSTKEY)) {
        cut(i);
        parts.push(HOSTKEY_REPL);
        last = i + NEEDLE_HOSTKEY.length;
        found++;
        i = last;
        continue;
      }
      // rule 3: anti-devtools guard (anchored on the threshold config)
      if (kind === 'boot' && startsWith(u8, i, NEEDLE_GUARD)) {
        cut(i);
        parts.push(GUARD_REPL);
        last = i + NEEDLE_GUARD.length;
        found++;
        i = last;
        continue;
      }
      // rule 1: domain lock  if(!_0xXXXX){var _0xYYYY=new RegExp('  ->  if(!1){
      if (u8[i] === 105 && u8[i + 1] === 102 && u8[i + 2] === 40 && u8[i + 3] === 33 &&
          u8[i + 4] === 95 && u8[i + 5] === 48 && u8[i + 6] === 120) {
        var j = i + 7;
        while (j < n && isHex(u8[j])) j++;
        if (j > i + 7 && u8[j] === 41 && u8[j + 1] === 123 &&
            u8[j + 2] === 118 && u8[j + 3] === 97 && u8[j + 4] === 114 && u8[j + 5] === 32 &&
            u8[j + 6] === 95 && u8[j + 7] === 48 && u8[j + 8] === 120) {
          var k = j + 9;
          while (k < n && isHex(u8[k])) k++;
          if (k > j + 9 &&
              u8[k] === 61 && u8[k + 1] === 110 && u8[k + 2] === 101 && u8[k + 3] === 119 && u8[k + 4] === 32 &&
              u8[k + 5] === 82 && u8[k + 6] === 101 && u8[k + 7] === 103 && u8[k + 8] === 69 &&
              u8[k + 9] === 120 && u8[k + 10] === 112 && u8[k + 11] === 40 && u8[k + 12] === 39) {
            cut(i + 4);   // keep "if(!"
            parts.push(ONE);
            last = j;     // resume at ")"
            found++;
            i = k + 13;
            continue;
          }
        }
      }
      i++;
    }
    if (!found) return null;
    parts.push(u8.subarray(last));
    return { blob: new Blob(parts, { type: 'application/javascript' }), found: found };
  }

  function kindOf(url) {
    if (ENGINE_RE.test(url)) return 'engine';
    if (BOOT_RE.test(url)) return 'boot';
    return 'bundle';
  }

  // advisory syntax check - logs a warning, never changes behaviour
  function sanityCheck(ab, url) {
    try {
      new Function(new TextDecoder('utf-8').decode(ab));
    } catch (e) {
      console.warn('[hld] warning: patched script failed the syntax check (still shipped): ' + url + ' :: ' + (e && e.message));
    }
  }

  function fetchAndPatch(url) {
    var kind = kindOf(url);
    return fetch(url, { credentials: 'omit' }).then(function (res) {
      if (!res.ok) throw new Error('http ' + res.status);
      return res.arrayBuffer();
    }).then(function (ab) {
      var r = patchBytes(new Uint8Array(ab), kind);
      if (!r) {
        console.warn('[hld] no patch point found, shipping as-is: ' + url);
        return null;
      }
      console.log('[hld] patched ' + r.found + ' site(s) (' + kind + ') - ' +
        Math.round(ab.byteLength / 1024) + 'KB - ' + url.replace(CDN_PREFIX, ''));
      return r.blob.arrayBuffer().then(function (patched) {
        sanityCheck(patched, url);
        return new Blob([patched], { type: 'application/javascript' });
      });
    });
  }

  function cacheGet(url) {
    if (!window.caches) return Promise.resolve(null);
    return caches.open(CACHE_NAME).then(function (c) { return c.match(url); }).then(function (r) {
      return r ? r.blob() : null;
    }).catch(function () { return null; });
  }

  function cachePut(url, blob) {
    if (!window.caches) return Promise.resolve();
    return caches.open(CACHE_NAME).then(function (c) {
      return c.put(url, new Response(blob, { headers: { 'Content-Type': 'application/javascript' } }));
    }).catch(function () {});
  }

  function resolvePatched(url) {
    if (mem[url]) return Promise.resolve(mem[url]);
    return cacheGet(url).then(function (blob) {
      if (blob) { mem[url] = URL.createObjectURL(blob); return mem[url]; }
      return fetchAndPatch(url).then(function (b) {
        if (!b) return null;
        mem[url] = URL.createObjectURL(b);
        cachePut(url, b);
        return mem[url];
      });
    });
  }

  // ---- intercept <script src>, swap in the patched blob ----
  var proto = window.HTMLScriptElement && window.HTMLScriptElement.prototype;
  if (proto) {
    var d = Object.getOwnPropertyDescriptor(proto, 'src');
    var rawSetSrc = (d && d.set) ? d.set : function (v) { proto.setAttribute.call(this, 'src', v); };
    var rawGetSrc = (d && d.get) ? d.get : function () { return this.getAttribute('src') || ''; };
    var rawSetAttr = proto.setAttribute;

    function rewrite(el, abs) {
      el.__hldPending = abs;
      resolvePatched(abs).then(function (u) {
        if (el.__hldPending !== abs) return;
        rawSetSrc.call(el, u || abs);
      }, function (e) {
        if (el.__hldPending !== abs) return;
        console.warn('[hld] fetch failed, falling back to the original url: ' + abs, e);
        rawSetSrc.call(el, abs);
      });
    }

    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: d ? d.enumerable : true,
      get: function () { return rawGetSrc.call(this); },
      set: function (v) {
        var abs = null;
        try { abs = new URL(String(v), document.baseURI).href; } catch (e) {}
        if (abs && isTarget(abs)) { rewrite(this, abs); return; }
        rawSetSrc.call(this, v);
      }
    });

    proto.setAttribute = function (name, value) {
      if (String(name).toLowerCase() === 'src') { this.src = value; return; }
      return rawSetAttr.call(this, name, value);
    };
  }

  window.__HLD_HOOK__ = { version: '2.1', isTarget: function (u) { return isTarget(u); } };
})();
