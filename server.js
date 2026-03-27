const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createProxyMiddleware } = require("http-proxy-middleware");

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
  maxResponseSize: 100 * 1024 * 1024, // Increased to 100MB for bigger videos/games
  timeout: 45000, // Slightly longer timeout
};

const STREAM_CONTENT_TYPES = [
  "video/", "audio/", "application/x-mpegURL", "application/vnd.apple.mpegurl",
  "application/dash+xml", "application/octet-stream",
];

const PASSTHROUGH_CONTENT_TYPES = [
  "image/", "font/", "application/font", "application/x-font",
  "application/wasm", "application/zip", "application/x-zip",
];

// ─── Helper Functions ─────────────────────────────────────────────────────────
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
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("#") ||
      url.startsWith("javascript:") || url.startsWith("mailto:")) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function proxyUrl(url) {
  if (!url) return url;
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("#") ||
      url.startsWith("javascript:") || url.startsWith("mailto:") ||
      url.startsWith("/proxy/fetch") || url.startsWith("/proxy/ws")) return url;
  return "/proxy/fetch?url=" + encodeURIComponent(url);
}

// ─── Rewriters ────────────────────────────────────────────────────────────────
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

function rewriteJS(js, baseUrl) {
  if (!js || typeof js !== "string") return js;

  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return ""; } })();

  // Basic absolute URLs in strings
  js = js.replace(
    /(["'`])(https?:\/\/[^"'`\s]+?)(["'`])/g,
    (match, q1, url, q2) => {
      if (url.includes(location?.hostname || "")) return match;
      return `${q1}${proxyUrl(url)}${q2}`;
    }
  );

  // fetch() calls
  js = js.replace(
    /\bfetch\s*\(\s*(["'`])(https?:\/\/[^"'`\s]+)\1/g,
    (match, q, url) => `fetch(${q}${proxyUrl(url)}${q}`
  );

  // XMLHttpRequest.open
  js = js.replace(
    /(\.open\s*\(\s*["'`][A-Z]+["'`]\s*,\s*)(["'`])(https?:\/\/[^"'`\s]+)\2/g,
    (match, prefix, q, url) => `${prefix}${q}${proxyUrl(url)}${q}`
  );

  // new URL()
  js = js.replace(
    /new\s+URL\s*\(\s*(["'`])(https?:\/\/[^"'`\s]+)\1/g,
    (match, q, url) => `new URL(${q}${proxyUrl(url)}${q}`
  );

  // WebSocket
  js = js.replace(
    /new\s+WebSocket\s*\(\s*(["'`])(wss?:\/\/[^"'`\s]+)\1/g,
    (match, q, wsUrl) => {
      const proxied = "/proxy/ws?url=" + encodeURIComponent(wsUrl);
      return `new WebSocket(${q}${proxied}${q}`;
    }
  );

  return js;
}

function rewriteHTML(html, baseUrl) {
  if (!html || typeof html !== "string") return html;

  let effectiveBase = baseUrl;
  html = html.replace(/<base([^>]*)\s+href\s*=\s*(["'])(.*?)\2([^>]*)>/gi, (match, pre, q, href, post) => {
    const abs = toAbsolute(href, baseUrl);
    effectiveBase = abs || baseUrl;
    return `<base${pre} href="${proxyUrl(abs)}"${post}>`;
  });

  // Rewrite common attributes
  html = html.replace(
    /(\s)(src|href|action|data-src|data-href|poster|data-url|data-cdn|data-domain)\s*=\s*(["'])(.*?)\3/gi,
    (match, space, attr, quote, val) => {
      if (!val || val.startsWith("data:") || val.startsWith("blob:") || val.startsWith("#") ||
          val.startsWith("javascript:") || val.startsWith("mailto:")) return match;
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return match;
      return `${space}${attr}=${quote}${proxyUrl(abs)}${quote}`;
    }
  );

  // srcset
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

  // <source>, <track>, <video>, <audio>, <iframe>
  html = html.replace(/<source([^>]*?)>/gi, (match, attrs) => {
    attrs = attrs.replace(/\s(src|srcset)\s*=\s*(["'])(.*?)\2/gi, (m, attr, q, val) => {
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return m;
      return ` ${attr}=${q}${proxyUrl(abs)}${q}`;
    });
    return `<source${attrs}>`;
  });

  html = html.replace(/<track([^>]*?)>/gi, (match, attrs) => {
    attrs = attrs.replace(/\ssrc\s*=\s*(["'])(.*?)\1/gi, (m, q, val) => {
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return m;
      return ` src=${q}${proxyUrl(abs)}${q}`;
    });
    return `<track${attrs}>`;
  });

  html = html.replace(/<(video|audio)([^>]*?)>/gi, (match, tag, attrs) => {
    attrs = attrs.replace(/\ssrc\s*=\s*(["'])(.*?)\1/gi, (m, q, val) => {
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return m;
      return ` src=${q}${proxyUrl(abs)}${q}`;
    });
    return `<${tag}${attrs}>`;
  });

  html = html.replace(/<iframe([^>]*?)>/gi, (match, attrs) => {
    attrs = attrs.replace(/\ssrc\s*=\s*(["'])(.*?)\1/gi, (m, q, val) => {
      const abs = toAbsolute(val, effectiveBase);
      if (!abs || !abs.startsWith("http")) return m;
      return ` src=${q}${proxyUrl(abs)}${q}`;
    });
    attrs = attrs.replace(/\ssandbox\s*=\s*(["'])[^"']*\1/gi, '');
    return `<iframe${attrs} allow="autoplay; fullscreen; encrypted-media; gamepad; accelerometer; gyroscope; magnetometer">`;
  });

  // Inline styles and <style> blocks
  html = html.replace(
    /(\sstyle\s*=\s*)(["'])(.*?)\2/gi,
    (match, attr, quote, style) => `${attr}${quote}${rewriteCSS(style, effectiveBase)}${quote}`
  );

  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (match, open, css, close) => `${open}${rewriteCSS(css, effectiveBase)}${close}`
  );

  // Inline scripts (skip JSON)
  html = html.replace(
    /(<script(?:[^>]*?(?!src\s*=)[^>]*)?>)([\s\S]*?)(<\/script>)/gi,
    (match, open, js, close) => {
      if (open.includes("src=") || open.includes('type="application/json"') || open.includes("type='application/json'")) return match;
      return `${open}${rewriteJS(js, effectiveBase)}${close}`;
    }
  );

  // Remove restrictive meta tags
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["'](content-security-policy|x-frame-options|referrer-policy|cross-origin)[^>]*\/?>/gi,
    ""
  );

  // Meta refresh
  html = html.replace(
    /(<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*)([^"'\s]+)/gi,
    (match, prefix, url) => {
      const abs = toAbsolute(url, effectiveBase);
      return abs ? `${prefix}${proxyUrl(abs)}` : match;
    }
  );

  // Injected navigation + patching script (improved)
  const injected = `
<script>
(function() {
  var BASE = ${JSON.stringify(baseUrl)};
  var PROXY = '/proxy/fetch?url=';

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

  // Click & form interception
  document.addEventListener('click', function(e) {
    var el = e.target.closest ? e.target.closest('a[href]') : null;
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    sendNav(href);
  }, true);

  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form || !form.action) return;
    e.preventDefault(); e.stopImmediatePropagation();
    try {
      var action = new URL(form.action, BASE).href;
      sendNav(action);
    } catch(ex) {}
  }, true);

  // History API
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

  // Enhanced fetch patch
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      var urlStr = typeof input === 'string' ? input : (input && input.url);
      if (urlStr && urlStr.startsWith('http') && !urlStr.includes(location.hostname)) {
        var proxied = PROXY + encodeURIComponent(urlStr);
        if (typeof input === 'string') input = proxied;
        else input = new Request(proxied, input);
      }
    } catch(e) {}
    return _fetch.apply(this, arguments);
  };

  // XMLHttpRequest patch
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
    try {
      if (url && url.startsWith('http') && !url.includes(location.hostname)) {
        url = PROXY + encodeURIComponent(url);
      }
    } catch(e) {}
    return _open.call(this, method, url, async !== false, user, pass);
  };

  // WebSocket shim
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
  Object.setPrototypeOf(window.WebSocket, _WS);

  // Fullscreen + gamepad support
  document.addEventListener('keydown', function(e) {
    if (e.key === 'F11') {
      e.preventDefault();
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
    }
  });

  window.top.postMessage({ type: 'proxy-url', url: BASE }, '*');
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

function rewriteM3U8(text, baseUrl) {
  if (!text) return text;
  return text.split("\n").map(line => {
    line = line.trim();
    if (!line) return line;

    // URI= in tags (EXT-X-KEY, EXT-X-MAP, etc.)
    if (line.startsWith("#") && line.includes("URI=")) {
      return line.replace(/URI=(["']?)([^"'\s,]+)\1/g, (m, q, uri) => {
        const abs = toAbsolute(uri, baseUrl);
        return `URI=${q}${proxyUrl(abs)}${q}`;
      });
    }

    // Non-comment lines (segments)
    if (!line.startsWith("#")) {
      const abs = toAbsolute(line, baseUrl);
      if (abs && abs.startsWith("http")) return proxyUrl(abs);
    }
    return line;
  }).join("\n");
}

function rewriteMPD(xml, baseUrl) {
  if (!xml) return xml;
  return xml.replace(/<BaseURL>(.*?)<\/BaseURL>/gi, (match, url) => {
    const abs = toAbsolute(url.trim(), baseUrl);
    return `<BaseURL>${proxyUrl(abs)}</BaseURL>`;
  });
}

// ─── Headers ──────────────────────────────────────────────────────────────────
function setPermissiveHeaders(res) {
  res.removeHeader("X-Frame-Options");
  res.removeHeader("Content-Security-Policy");
  res.removeHeader("Cross-Origin-Embedder-Policy");
  res.removeHeader("Cross-Origin-Opener-Policy");
  res.removeHeader("Cross-Origin-Resource-Policy");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type, Range, ETag, Last-Modified");
  res.setHeader("Accept-Ranges", "bytes"); // Critical for video seeking
}

// ─── Proxy Route ──────────────────────────────────────────────────────────────
app.options("/proxy/fetch", (req, res) => {
  setPermissiveHeaders(res);
  res.sendStatus(204);
});

app.all("/proxy/fetch", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url=" });

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol))
      return res.status(400).json({ error: "Only http/https allowed" });
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (isBlockedDomain(url))
    return res.status(403).json({ error: "Domain blocked" });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_CONFIG.timeout);

    const reqHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      "Accept": req.headers.accept || "*/*",
      "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
      "Referer": parsedUrl.origin + "/",
      "Origin": parsedUrl.origin,
    };

    if (req.headers.range) reqHeaders.Range = req.headers.range;
    if (req.headers["if-none-match"]) reqHeaders["If-None-Match"] = req.headers["if-none-match"];
    if (req.headers["if-modified-since"]) reqHeaders["If-Modified-Since"] = req.headers["if-modified-since"];

    const fetchOptions = {
      method: req.method,
      signal: controller.signal,
      headers: reqHeaders,
      redirect: "follow",
    };

    if (["POST", "PUT", "PATCH"].includes(req.method)) {
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
    const forwardHeaders = ["content-type", "cache-control", "last-modified", "etag", "accept-ranges", "content-range", "expires"];
    forwardHeaders.forEach(h => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    const status = response.status;

    // HTML
    if (contentType.includes("text/html")) {
      const html = await response.text();
      res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(rewriteHTML(html, url));
    }

    // CSS
    if (contentType.includes("text/css")) {
      const css = await response.text();
      res.status(status).setHeader("Content-Type", "text/css; charset=utf-8");
      return res.send(rewriteCSS(css, url));
    }

    // JS
    if (contentType.includes("javascript")) {
      const js = await response.text();
      res.status(status).setHeader("Content-Type", contentType);
      return res.send(rewriteJS(js, url));
    }

    // HLS
    if (contentType.includes("mpegurl") || url.toLowerCase().includes(".m3u8")) {
      const text = await response.text();
      res.status(status).setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.send(rewriteM3U8(text, url));
    }

    // DASH
    if (contentType.includes("dash+xml") || url.toLowerCase().includes(".mpd")) {
      const xml = await response.text();
      res.status(status).setHeader("Content-Type", "application/dash+xml");
      return res.send(rewriteMPD(xml, url));
    }

    // Streaming media (video/audio)
    if (STREAM_CONTENT_TYPES.some(t => contentType.startsWith(t))) {
      res.status(status);
      if (response.body) {
        response.body.pipe(res);
        response.body.on("error", (err) => {
          console.error("Stream error:", err.message);
          if (!res.writableEnded) res.end();
        });
      }
      return;
    }

    // WASM / binary passthrough
    if (contentType.includes("wasm") || PASSTHROUGH_CONTENT_TYPES.some(t => contentType.startsWith(t))) {
      res.status(status);
      if (contentType.includes("wasm")) res.setHeader("Content-Type", "application/wasm");
      const buf = await response.arrayBuffer();
      return res.send(Buffer.from(buf));
    }

    // Fallback stream / buffer
    res.status(status);
    if (response.body && response.body.pipe) {
      response.body.pipe(res);
    } else {
      const buf = await response.arrayBuffer();
      res.send(Buffer.from(buf));
    }

  } catch (err) {
    if (err.name === "AbortError") return res.status(504).json({ error: "Request timed out" });
    console.error("[Proxy error]", err);
    return res.status(502).json({ error: "Failed to fetch", detail: err.message });
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

  try { new URL(targetWs); } catch { return socket.destroy(); }
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
      clientWs.close(1011, "Failed to connect");
      return;
    }

    serverWs.on("message", (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
    });
    clientWs.on("message", (data, isBinary) => {
      if (serverWs.readyState === WebSocket.OPEN) serverWs.send(data, { binary: isBinary });
    });

    serverWs.on("close", (code, reason) => clientWs.close(code, reason));
    clientWs.on("close", (code, reason) => serverWs.close(code, reason));

    serverWs.on("error", () => clientWs.close(1011));
    clientWs.on("error", () => serverWs.close());
  });
});

// ─── UI Route ─────────────────────────────────────────────────────────────────
app.get("/proxy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proxy.html"));
});

// The rest of your code (ping, bans, users, socket.io handlers, etc.) remains unchanged
// ─── Auto Ping ────────────────────────────────────────────────────────────────
const https = require("https");
const URL_PING = "https://clevereducation.online/";

function ping() {
  https.get(URL_PING, (res) => {
    console.log(`Pinged! Status: ${res.statusCode}`);
  }).on("error", (err) => console.log("Ping error:", err.message));
}
setInterval(ping, 300000);
ping();

// Persistence, users, socket.io, etc. (copy from your original code here)
const bansFile = path.join(__dirname, "bans.json");
const usersFile = path.join(__dirname, "users.json");

let bannedIPs = fs.existsSync(bansFile) ? JSON.parse(fs.readFileSync(bansFile, "utf-8")) : {};
let registeredUsers = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, "utf-8")) : {};

function saveBans() { fs.writeFileSync(bansFile, JSON.stringify(bannedIPs, null, 2)); }
function saveUsers() { fs.writeFileSync(usersFile, JSON.stringify(registeredUsers, null, 2)); }

// In-memory state, helpers, word lists, filterMessage, etc. → copy from your original

// Socket.IO connection handler → copy your full original io.on("connection", ...) block here

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
