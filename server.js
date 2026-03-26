const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createProxyMiddleware } = require("http-proxy-middleware"); // npm i http-proxy-middleware

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024,
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(express.static("public"));

// ─── Fetch ────────────────────────────────────────────────────────────────────

let fetchFn;
try {
  fetchFn = fetch;
} catch {
  fetchFn = require("node-fetch");
}

// ─── Proxy Config ─────────────────────────────────────────────────────────────

const PROXY_CONFIG = {
  blockedDomains: [
    "localhost", "127.0.0.1", "0.0.0.0",
    "169.254.", "10.", "192.168.", "172.16.",
  ],
  maxResponseSize: 50 * 1024 * 1024, // 50MB for videos/games
  timeout: 30000,
};

const STREAM_CONTENT_TYPES = [
  "video/", "audio/", "application/x-mpegURL", "application/vnd.apple.mpegurl",
  "application/dash+xml", "application/octet-stream",
];

const PASSTHROUGH_CONTENT_TYPES = [
  "image/", "font/", "application/font", "application/x-font",
  "application/wasm", // WebAssembly for games
  "application/zip", "application/x-zip",
];

function isBlockedDomain(url) {
  try {
    const { hostname } = new URL(url);
    return PROXY_CONFIG.blockedDomains.some((b) => hostname.includes(b));
  } catch {
    return true;
  }
}

function toAbsolute(url, base) {
  if (!url) return url;
  url = url.trim();
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("#") ||
    url.startsWith("javascript:") ||
    url.startsWith("mailto:")
  ) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function proxyUrl(url) {
  if (!url) return url;
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("#") ||
    url.startsWith("javascript:") ||
    url.startsWith("mailto:") ||
    url.startsWith("/proxy/fetch") ||
    url.startsWith("/proxy/ws")
  ) return url;
  return "/proxy/fetch?url=" + encodeURIComponent(url);
}

// ─── CSS Rewriter ─────────────────────────────────────────────────────────────

function rewriteCSS(css, baseUrl) {
  if (!css || typeof css !== "string") return css;

  css = css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, rawUrl) => {
    if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return match;
    const abs = toAbsolute(rawUrl, baseUrl);
    if (!abs || !abs.startsWith("http")) return match;
    return `url(${quote}${proxyUrl(abs)}${quote})`;
  });

  css = css.replace(/@import\s+(["'])(.*?)\1/gi, (match, quote, rawUrl) => {
    const abs = toAbsolute(rawUrl, baseUrl);
    if (!abs || !abs.startsWith("http")) return match;
    return `@import ${quote}${proxyUrl(abs)}${quote}`;
  });

  return css;
}

// ─── JS Rewriter ──────────────────────────────────────────────────────────────

function rewriteJS(js, baseUrl) {
  if (!js || typeof js !== "string") return js;

  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return ""; } })();
  if (!origin) return js;

  // Rewrite fetch() calls pointing to same origin or absolute URLs
  js = js.replace(
    /\bfetch\s*\(\s*(["'`])(https?:\/\/[^"'`\s]+)\1/g,
    (match, q, url) => {
      const proxied = proxyUrl(url);
      return `fetch(${q}${proxied}${q}`;
    }
  );

  // Rewrite XMLHttpRequest.open with absolute URLs
  js = js.replace(
    /(\.open\s*\(\s*["'`][A-Z]+["'`]\s*,\s*)(["'`])(https?:\/\/[^"'`\s]+)\2/g,
    (match, prefix, q, url) => {
      return `${prefix}${q}${proxyUrl(url)}${q}`;
    }
  );

  // Rewrite WebSocket URLs
  js = js.replace(
    /new\s+WebSocket\s*\(\s*(["'`])(wss?:\/\/[^"'`\s]+)\1/g,
    (match, q, wsUrl) => {
      const proxied = "/proxy/ws?url=" + encodeURIComponent(wsUrl);
      return `new WebSocket(${q}${proxied}${q}`;
    }
  );

  return js;
}

// ─── HTML Rewriter ────────────────────────────────────────────────────────────

function rewriteHTML(html, baseUrl) {
  if (!html || typeof html !== "string") return html;

  const parsedBase = (() => { try { return new URL(baseUrl); } catch { return null; } })();

  // 1. Rewrite <base href> and capture it
  let effectiveBase = baseUrl;
  html = html.replace(/<base([^>]*)\s+href\s*=\s*(["'])(.*?)\2([^>]*)>/gi, (match, pre, q, href, post) => {
    const abs = toAbsolute(href, baseUrl);
    effectiveBase = abs || baseUrl;
    return `<base${pre} href="${proxyUrl(abs)}"${post}>`;
  });

  // 2. Rewrite src, href, action, data-src, poster, content (meta refresh)
  html = html.replace(
    /(\s)(src|href|action|data-src|data-href|poster|data-url|data-cdn|data-domain)\s*=\s*(["'])(.*?)\3/gi,
    (match, space, attr, quote, val) => {
      if (!val || val.startsWith("data:") || val.startsWith("blob:") || val.startsWith("#") || val.startsWith("javascript:") || val.startsWith("mailto:")) return match;
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return match;
      return `${space}${attr}=${quote}${proxyUrl(abs)}${quote}`;
    }
  );

  // 3. Rewrite srcset
  html = html.replace(
    /(\s)(srcset)\s*=\s*(["'])(.*?)\3/gi,
    (match, space, attr, quote, val) => {
      const rewritten = val.replace(/([^\s,]+)(\s+[\d.]+[wx])?/g, (m, u, descriptor) => {
        if (!u || u.startsWith("data:")) return m;
        const abs = toAbsolute(u.trim(), effectiveBase);
        if (!abs || !abs.startsWith("http")) return m;
        return proxyUrl(abs) + (descriptor || "");
      });
      return `${space}${attr}=${quote}${rewritten}${quote}`;
    }
  );

  // 4. Rewrite <source> tags (video/audio/picture)
  html = html.replace(/<source([^>]*?)>/gi, (match, attrs) => {
    attrs = attrs.replace(/\s(src|srcset)\s*=\s*(["'])(.*?)\2/gi, (m, attr, q, val) => {
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return m;
      return ` ${attr}=${q}${proxyUrl(abs)}${q}`;
    });
    return `<source${attrs}>`;
  });

  // 5. Rewrite <track> tags (subtitles/captions)
  html = html.replace(/<track([^>]*?)>/gi, (match, attrs) => {
    attrs = attrs.replace(/\ssrc\s*=\s*(["'])(.*?)\1/gi, (m, q, val) => {
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return m;
      return ` src=${q}${proxyUrl(abs)}${q}`;
    });
    return `<track${attrs}>`;
  });

  // 6. Rewrite <video> and <audio> src
  html = html.replace(/<(video|audio)([^>]*?)>/gi, (match, tag, attrs) => {
    attrs = attrs.replace(/\ssrc\s*=\s*(["'])(.*?)\1/gi, (m, q, val) => {
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return m;
      return ` src=${q}${proxyUrl(abs)}${q}`;
    });
    return `<${tag}${attrs}>`;
  });

  // 7. Rewrite <iframe> src
  html = html.replace(/<iframe([^>]*?)>/gi, (match, attrs) => {
    attrs = attrs.replace(/\ssrc\s*=\s*(["'])(.*?)\1/gi, (m, q, val) => {
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return m;
      return ` src=${q}${proxyUrl(abs)}${q}`;
    });
    // Remove sandbox restrictions that break functionality
    attrs = attrs.replace(/\ssandbox\s*=\s*(["'])[^"']*\1/gi, '');
    return `<iframe${attrs} allow="autoplay; fullscreen; encrypted-media; gamepad">`;
  });

  // 8. Rewrite <script type="application/json"> / JSON-LD with URLs (skip execution)
  // Rewrite inline style attributes
  html = html.replace(
    /(\sstyle\s*=\s*)(["'])(.*?)\2/gi,
    (match, attr, quote, style) => `${attr}${quote}${rewriteCSS(style, effectiveBase)}${quote}`
  );

  // 9. Rewrite <style> blocks
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (match, open, css, close) => `${open}${rewriteCSS(css, effectiveBase)}${close}`
  );

  // 10. Rewrite inline <script> blocks (best-effort)
  html = html.replace(
    /(<script(?:[^>]*?(?!src\s*=)[^>]*)?>)([\s\S]*?)(<\/script>)/gi,
    (match, open, js, close) => {
      if (open.includes("src=")) return match; // external script, skip
      if (open.includes('type="application/json"') || open.includes("type='application/json'")) return match;
      return `${open}${rewriteJS(js, effectiveBase)}${close}`;
    }
  );

  // 11. Remove CSP and X-Frame-Options meta tags
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["'](content-security-policy|x-frame-options|referrer-policy)["'][^>]*\/?>/gi,
    ""
  );

  // 12. Fix meta refresh redirects
  html = html.replace(
    /(<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*)([^"'\s]+)/gi,
    (match, prefix, url) => {
      const abs = toAbsolute(url, effectiveBase);
      return abs ? `${prefix}${proxyUrl(abs)}` : match;
    }
  );

  // 13. Inject comprehensive navigation interceptor + media/game support
  const injected = `
<script>
(function() {
  var BASE = ${JSON.stringify(baseUrl)};
  var PROXY = '/proxy/fetch?url=';

  // ── Navigation helpers ────────────────────────────────────────────────────
  function toAbs(url) {
    try { return new URL(url, BASE).href; } catch(e) { return null; }
  }
  function sendNav(url) {
    var abs = toAbs(url);
    if (abs && abs.startsWith('http')) {
      window.top.postMessage({ type: 'proxy-navigate', url: abs }, '*');
      return true;
    }
    return false;
  }

  // ── Intercept anchor clicks ───────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    var el = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (el.target && el.target === '_blank') { el.removeAttribute('target'); }
    e.preventDefault(); e.stopPropagation();
    sendNav(href);
  }, true);

  // ── Intercept form submissions ────────────────────────────────────────────
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || !form.action) return;
    e.preventDefault(); e.stopPropagation();
    try {
      var action = new URL(form.action, BASE).href;
      var data = new URLSearchParams(new FormData(form)).toString();
      var method = (form.method || 'get').toLowerCase();
      if (method === 'get') {
        sendNav(action.split('?')[0] + (data ? '?' + data : ''));
      } else {
        // POST forms: navigate to action with query for now
        sendNav(action);
      }
    } catch(ex) {}
  }, true);

  // ── Intercept history API ─────────────────────────────────────────────────
  function wrapHistory(method) {
    var orig = history[method];
    history[method] = function(state, title, url) {
      orig.apply(this, arguments);
      if (url) {
        try {
          var abs = new URL(url, BASE).href;
          window.top.postMessage({ type: 'proxy-url', url: abs }, '*');
          BASE = abs;
        } catch(ex) {}
      }
    };
  }
  try { wrapHistory('pushState'); wrapHistory('replaceState'); } catch(ex) {}

  // ── Patch fetch to proxy unknown URLs ────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (url && url.startsWith('http') && !url.includes(location.hostname)) {
        var proxied = PROXY + encodeURIComponent(url);
        input = typeof input === 'string' ? proxied : new Request(proxied, input);
      }
    } catch(e) {}
    return _fetch.apply(this, arguments);
  };

  // ── Patch XMLHttpRequest ──────────────────────────────────────────────────
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
    try {
      if (url && url.startsWith('http') && !url.includes(location.hostname)) {
        url = PROXY + encodeURIComponent(url);
      }
    } catch(e) {}
    return _open.call(this, method, url, async !== false, user, pass);
  };

  // ── WebSocket proxy shim ──────────────────────────────────────────────────
  var _WS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    try {
      if (url && (url.startsWith('ws://') || url.startsWith('wss://'))) {
        var wsProxy = location.origin.replace('http', 'ws') + '/proxy/ws?url=' + encodeURIComponent(url);
        return protocols ? new _WS(wsProxy, protocols) : new _WS(wsProxy);
      }
    } catch(e) {}
    return protocols ? new _WS(url, protocols) : new _WS(url);
  };
  window.WebSocket.prototype = _WS.prototype;
  window.WebSocket.CONNECTING = _WS.CONNECTING;
  window.WebSocket.OPEN = _WS.OPEN;
  window.WebSocket.CLOSING = _WS.CLOSING;
  window.WebSocket.CLOSED = _WS.CLOSED;

  // ── Fullscreen support for games/videos ───────────────────────────────────
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F11') {
      e.preventDefault();
      var el = document.documentElement;
      if (!document.fullscreenElement) {
        el.requestFullscreen && el.requestFullscreen();
      } else {
        document.exitFullscreen && document.exitFullscreen();
      }
    }
  });

  // ── Report current URL to parent ──────────────────────────────────────────
  try { window.top.postMessage({ type: 'proxy-url', url: BASE }, '*'); } catch(ex) {}

  // ── Gamepad API pass-through (needed for game controllers) ────────────────
  // No patching needed — gamepad API works natively in iframes

  // ── Canvas / WebGL override for cross-origin game assets ─────────────────
  // Allow cross-origin images on canvas (avoids taint)
  var _createEl = document.createElement.bind(document);
  document.createElement = function(tag) {
    var el = _createEl(tag);
    if (typeof tag === 'string' && tag.toLowerCase() === 'img') {
      el.crossOrigin = 'anonymous';
    }
    return el;
  };

})();
</script>`;

  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, injected + "</body>");
  } else if (/<\/html>/i.test(html)) {
    html = html.replace(/<\/html>/i, injected + "</html>");
  } else {
    html += injected;
  }

  return html;
}

// ─── Manifest / HLS / DASH rewriter ──────────────────────────────────────────

function rewriteM3U8(text, baseUrl) {
  return text.split("\n").map(line => {
    line = line.trim();
    if (!line || line.startsWith("#EXT") && !line.includes("URI=")) return line;
    // Rewrite URI= values in tags like #EXT-X-KEY, #EXT-X-MAP
    if (line.startsWith("#") && line.includes('URI="')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        const abs = toAbsolute(uri, baseUrl);
        return `URI="${proxyUrl(abs)}"`;
      });
    }
    // Rewrite segment URLs
    if (!line.startsWith("#")) {
      const abs = toAbsolute(line, baseUrl);
      return proxyUrl(abs);
    }
    return line;
  }).join("\n");
}

function rewriteMPD(xml, baseUrl) {
  // DASH manifests: rewrite BaseURL and initialization/media templates
  return xml.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, url) => {
    const abs = toAbsolute(url.trim(), baseUrl);
    return `<BaseURL>${proxyUrl(abs)}</BaseURL>`;
  });
}

// ─── Common response headers ──────────────────────────────────────────────────

function setPermissiveHeaders(res) {
  res.removeHeader("X-Frame-Options");
  res.removeHeader("Content-Security-Policy");
  res.removeHeader("Cross-Origin-Embedder-Policy");
  res.removeHeader("Cross-Origin-Opener-Policy");
  res.removeHeader("Cross-Origin-Resource-Policy");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

// ─── Proxy fetch route ────────────────────────────────────────────────────────

app.options("/proxy/fetch", (req, res) => {
  setPermissiveHeaders(res);
  res.sendStatus(204);
});

app.all("/proxy/fetch", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol))
      return res.status(400).json({ error: "Only http/https URLs are allowed" });
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (isBlockedDomain(url))
    return res.status(403).json({ error: "This domain is not allowed" });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_CONFIG.timeout);

    // Forward relevant request headers
    const reqHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": req.headers["accept"] || "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Referer": parsedUrl.origin + "/",
      "Origin": parsedUrl.origin,
    };

    // Forward Range header for video seeking
    if (req.headers["range"]) {
      reqHeaders["Range"] = req.headers["range"];
    }
    if (req.headers["if-none-match"]) reqHeaders["If-None-Match"] = req.headers["if-none-match"];
    if (req.headers["if-modified-since"]) reqHeaders["If-Modified-Since"] = req.headers["if-modified-since"];

    const fetchOptions = {
      method: req.method,
      signal: controller.signal,
      headers: reqHeaders,
      redirect: "follow",
    };

    // Forward request body for POST
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      fetchOptions.body = Buffer.concat(chunks);
      if (req.headers["content-type"]) reqHeaders["Content-Type"] = req.headers["content-type"];
    }

    const response = await fetchFn(url, fetchOptions);
    clearTimeout(timer);

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const contentLength = parseInt(response.headers.get("content-length") || "0");

    if (contentLength > PROXY_CONFIG.maxResponseSize)
      return res.status(413).json({ error: "Response too large" });

    setPermissiveHeaders(res);

    // Forward useful headers
    const forwardHeaders = ["content-type", "cache-control", "last-modified", "etag",
      "accept-ranges", "content-range", "expires", "vary"];
    forwardHeaders.forEach((h) => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    // Mirror the status code (important for 206 Partial Content / video seeking)
    const status = response.status;

    // ── HTML ──────────────────────────────────────────────────────────────────
    if (contentType.includes("text/html")) {
      const html = await response.text();
      res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(rewriteHTML(html, url));
    }

    // ── CSS ───────────────────────────────────────────────────────────────────
    if (contentType.includes("text/css")) {
      const css = await response.text();
      res.status(status).setHeader("Content-Type", "text/css; charset=utf-8");
      return res.send(rewriteCSS(css, url));
    }

    // ── JavaScript ────────────────────────────────────────────────────────────
    if (contentType.includes("javascript")) {
      const js = await response.text();
      res.status(status).setHeader("Content-Type", contentType);
      return res.send(rewriteJS(js, url));
    }

    // ── HLS manifest (.m3u8) ──────────────────────────────────────────────────
    if (
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegurl") ||
      url.toLowerCase().includes(".m3u8")
    ) {
      const text = await response.text();
      res.status(status).setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewriteM3U8(text, url));
    }

    // ── DASH manifest ─────────────────────────────────────────────────────────
    if (contentType.includes("dash+xml") || url.toLowerCase().includes(".mpd")) {
      const xml = await response.text();
      res.status(status).setHeader("Content-Type", "application/dash+xml");
      return res.send(rewriteMPD(xml, url));
    }

    // ── JSON (may contain URLs) ───────────────────────────────────────────────
    if (contentType.includes("application/json")) {
      const json = await response.text();
      res.status(status).setHeader("Content-Type", "application/json");
      return res.send(json); // Pass-through; SPA routing handles URLs internally
    }

    // ── Streaming video/audio ─────────────────────────────────────────────────
    if (STREAM_CONTENT_TYPES.some(t => contentType.startsWith(t))) {
      res.status(status);
      return response.body.pipe(res);
    }

    // ── WebAssembly ───────────────────────────────────────────────────────────
    if (contentType.includes("wasm")) {
      res.status(status).setHeader("Content-Type", "application/wasm");
      const buf = await response.arrayBuffer();
      return res.send(Buffer.from(buf));
    }

    // ── Binary passthrough (images, fonts, etc.) ──────────────────────────────
    if (PASSTHROUGH_CONTENT_TYPES.some(t => contentType.startsWith(t)) || contentLength > 0) {
      // Stream large binary responses
      if (!contentLength || contentLength > 1 * 1024 * 1024) {
        res.status(status);
        if (response.body && response.body.pipe) {
          return response.body.pipe(res);
        }
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > PROXY_CONFIG.maxResponseSize)
        return res.status(413).json({ error: "Response too large" });
      return res.status(status).send(Buffer.from(buffer));
    }

    // ── Fallback: try to stream ───────────────────────────────────────────────
    res.status(status);
    if (response.body && response.body.pipe) {
      return response.body.pipe(res);
    }
    const buf = await response.arrayBuffer();
    return res.send(Buffer.from(buf));

  } catch (err) {
    if (err.name === "AbortError")
      return res.status(504).json({ error: "Request timed out" });
    console.error("[Proxy error]", err);
    return res.status(502).json({ error: "Failed to fetch URL", detail: err.cause?.message || err.message });
  }
});

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────

const WebSocket = require("ws");
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const urlParams = new URL(req.url, "http://localhost");
  if (urlParams.pathname !== "/proxy/ws") return socket.destroy();

  const targetWs = urlParams.searchParams.get("url");
  if (!targetWs) return socket.destroy();

  try {
    new URL(targetWs); // validate
  } catch {
    return socket.destroy();
  }

  if (isBlockedDomain(targetWs)) return socket.destroy();

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    let serverWs;
    try {
      serverWs = new WebSocket(targetWs, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Origin": new URL(targetWs).origin,
        },
      });
    } catch (e) {
      clientWs.close(1011, "Failed to connect to target");
      return;
    }

    serverWs.on("message", (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    });
    clientWs.on("message", (data, isBinary) => {
      if (serverWs.readyState === WebSocket.OPEN) serverWs.send(data, { binary: isBinary });
    });

    serverWs.on("close", (code, reason) => clientWs.close(code, reason));
    clientWs.on("close", (code, reason) => serverWs.close());

    serverWs.on("error", (err) => { console.error("[WS server error]", err); clientWs.close(1011); });
    clientWs.on("error", (err) => { console.error("[WS client error]", err); serverWs.close(); });
  });
});

// ─── Serve proxy UI ──────────────────────────────────────────────────────────

app.get("/proxy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy.html"));
});

// ─── Auto Ping ────────────────────────────────────────────────────────────────

const https = require("https");
const URL_PING = "https://clevereducation.online/";

function ping() {
  https.get(URL_PING, (res) => {
    console.log(`Pinged! Status: ${res.statusCode}`);
  }).on("error", (err) => {
    console.log("Ping error:", err.message);
  });
}

setInterval(ping, 300000);
ping();

// ─── Persistence ─────────────────────────────────────────────────────────────

const bansFile = path.join(__dirname, "bans.json");
const usersFile = path.join(__dirname, "users.json");

let bannedIPs = fs.existsSync(bansFile)
  ? JSON.parse(fs.readFileSync(bansFile, "utf-8"))
  : {};
let registeredUsers = fs.existsSync(usersFile)
  ? JSON.parse(fs.readFileSync(usersFile, "utf-8"))
  : {};

function saveBans() { fs.writeFileSync(bansFile, JSON.stringify(bannedIPs, null, 2)); }
function saveUsers() { fs.writeFileSync(usersFile, JSON.stringify(registeredUsers, null, 2)); }

// ─── In-memory state ──────────────────────────────────────────────────────────

const users = {};
const rateLimitMap = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function getClientIP(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  return forwarded ? forwarded.split(",")[0].trim() : socket.handshake.address;
}
function isValidColor(color) {
  return typeof color === "string" && /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.test(color);
}
function isValidUsername(name) {
  return typeof name === "string" && name.length >= 2 && name.length <= 18 && /^[\x21-\x7E]+$/.test(name);
}
function isRateLimited(socketId) {
  const now = Date.now();
  const WINDOW_MS = 5000;
  const MAX_MSGS = 8;
  if (!rateLimitMap[socketId]) { rateLimitMap[socketId] = { count: 1, windowStart: now }; return false; }
  const state = rateLimitMap[socketId];
  if (now - state.windowStart > WINDOW_MS) { state.count = 1; state.windowStart = now; return false; }
  state.count++;
  return state.count > MAX_MSGS;
}
function getRoomUsers(port) {
  return Object.values(users).filter((u) => u.port === port)
    .map((u) => ({ name: u.name, profilePic: u.profilePic, color: u.color }));
}
function safe(fn) {
  return (...args) => { try { fn(...args); } catch (err) { console.error("Socket handler error:", err); } };
}

// ─── Word lists ───────────────────────────────────────────────────────────────

const profanityWords = [
  "arse", "arsehead", "arsehole", "ass", "asshole", "ass hole",
  "bastard", "bitch", "bollocks", "bullshit", "crap", "dammit",
  "damned", "dick", "dickhead", "dick-head", "dumbass", "dumb ass",
  "dumb-ass", "horseshit",
];
const slurWords = ["fag", "faggot", "nigga", "nigra"];
const sexualWords = [
  "childfucker", "child-fucker", "cock", "cocksucker", "cunt",
  "fatherfucker", "father-fucker", "fuck", "fucked", "fucker",
  "fucking", "motherfucker", "mother fucker", "mother-fucker",
];

const normalize = (w) => w.toLowerCase().replace(/[^a-z]/g, "");
const LEET_MAP = { "4":"a","@":"a","8":"b","3":"e","6":"g","1":"i","!":"i","0":"o","5":"s","$":"s","7":"t" };

function normalizeForFilter(text) {
  if (!text) return "";
  let s = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[4836!105$7@]/g, (c) => LEET_MAP[c] || c).replace(/[^a-z]/g, "");
  return s;
}

function filterMessage(text) {
  if (!text || typeof text !== "string") return { allowed: true };
  const raw = text.toLowerCase();
  const stripped = normalizeForFilter(text);
  const wordMatch = (word) => new RegExp(`(?<![a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`).test(raw);
  const obfuscatedMatch = (word) => stripped.includes(normalize(word));
  for (const w of profanityWords) if (wordMatch(normalize(w)) || obfuscatedMatch(w)) return { allowed: false, reason: "Watch your language." };
  for (const w of sexualWords) if (wordMatch(normalize(w)) || obfuscatedMatch(w)) return { allowed: false, reason: "Keep it clean." };
  for (const w of slurWords) if (wordMatch(normalize(w)) || obfuscatedMatch(w)) return { allowed: false, reason: "Hate speech is not allowed." };
  return { allowed: true };
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  const ip = getClientIP(socket);
  if (bannedIPs[ip]) { socket.emit("banned", { by: "server" }); return socket.disconnect(true); }

  socket.on("login", safe(({ name, password, port, profilePic, color }) => {
    if (!isValidUsername(name)) return socket.emit("loginResult", { success: false, message: "Username must be 2–18 printable characters." });
    if (!password || typeof password !== "string") return socket.emit("loginResult", { success: false, message: "Password is required." });
    if (!port || typeof port !== "string" || port.trim() === "") return socket.emit("loginResult", { success: false, message: "Server port is required." });

    const safeColor = isValidColor(color) ? color : "rgb(255,255,255)";
    const hashed = hashPassword(password);

    if (registeredUsers[name]) {
      if (!safeEqual(registeredUsers[name].password, hashed)) return socket.emit("loginResult", { success: false, message: "Incorrect password." });
      if (profilePic && typeof profilePic === "string") registeredUsers[name].profilePic = profilePic;
      registeredUsers[name].color = safeColor;
      saveUsers();
    } else {
      registeredUsers[name] = { password: hashed, profilePic: typeof profilePic === "string" ? profilePic : "", color: safeColor };
      saveUsers();
      console.log(`Registered new user: ${name}`);
    }

    users[socket.id] = { name, ip, socket, port: port.trim(), profilePic: registeredUsers[name].profilePic, color: safeColor };
    socket.join(port.trim());
    io.to(port.trim()).emit("user list", getRoomUsers(port.trim()));
    socket.emit("loginResult", { success: true });
    console.log(`${name} joined room ${port.trim()} from ${ip}`);
  }));

  socket.on("chat message", safe((msg) => {
    const sender = users[socket.id];
    if (!sender) return;
    if (msg.image && msg.image.length > 2_000_000) return;
    if (isRateLimited(socket.id)) { socket.emit("chatBlocked", { reason: "Slow down — you're sending messages too fast." }); return; }
    if (msg.text !== undefined && msg.text !== null) {
      if (typeof msg.text !== "string") return;
      if (msg.text.length > 600) { socket.emit("chatBlocked", { reason: "Message too long (max 600 characters)." }); return; }
      const filter = filterMessage(msg.text);
      if (!filter.allowed) { socket.emit("chatBlocked", { reason: filter.reason }); return; }
    }
    const payload = {
      id: crypto.randomUUID(), user: sender.name, text: msg.text || null,
      image: msg.image || null, profilePic: sender.profilePic, color: sender.color, timestamp: Date.now(),
    };
    io.to(sender.port).emit("chat message", payload);
  }));

  socket.on("typing", safe((isTyping) => {
    const user = users[socket.id];
    if (!user) return;
    socket.to(user.port).emit("typing", { user: user.name, isTyping: Boolean(isTyping) });
  }));

  socket.on("colorChange", safe((newColor) => {
    const user = users[socket.id];
    if (!user || !isValidColor(newColor)) return;
    user.color = newColor;
    if (registeredUsers[user.name]) { registeredUsers[user.name].color = newColor; saveUsers(); }
    io.to(user.port).emit("colorChange", { user: user.name, color: newColor });
    io.to(user.port).emit("user list", getRoomUsers(user.port));
  }));

  socket.on("disconnect", safe(() => {
    const user = users[socket.id];
    if (user) {
      console.log(`${user.name} disconnected from room ${user.port}`);
      const port = user.port;
      delete users[socket.id];
      delete rateLimitMap[socket.id];
      io.to(port).emit("user list", getRoomUsers(port));
    }
  }));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
