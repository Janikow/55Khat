const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024,
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(express.static("public"));

// ─── Proxy ────────────────────────────────────────────────────────────────────

let fetchFn;
try {
  fetchFn = fetch;
} catch {
  fetchFn = require("node-fetch");
}

const PROXY_CONFIG = {
  blockedDomains: [
    "localhost", "127.0.0.1", "0.0.0.0",
    "169.254.", "10.", "192.168.", "172.16.",
  ],
  maxResponseSize: 15 * 1024 * 1024, // 15MB
  timeout: 20000,
};

function isBlockedDomain(url) {
  try {
    const { hostname } = new URL(url);
    return PROXY_CONFIG.blockedDomains.some((b) => hostname.includes(b));
  } catch {
    return true;
  }
}

/** Resolve any URL to absolute given a base URL */
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

/** Wrap a URL to route through our proxy */
function proxyUrl(url) {
  if (!url) return url;
  if (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("#") ||
    url.startsWith("javascript:") ||
    url.startsWith("mailto:") ||
    url.startsWith("/proxy/fetch")
  ) return url;
  return "/proxy/fetch?url=" + encodeURIComponent(url);
}

/** Rewrite CSS: url() and @import */
function rewriteCSS(css, baseUrl) {
  if (!css || typeof css !== "string") return css;

  // url("...") / url('...') / url(...)
  css = css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, rawUrl) => {
    if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return match;
    const abs = toAbsolute(rawUrl, baseUrl);
    if (!abs || !abs.startsWith("http")) return match;
    return `url(${quote}${proxyUrl(abs)}${quote})`;
  });

  // @import "url" or @import url(...)  — handle string form
  css = css.replace(/@import\s+(["'])(.*?)\1/gi, (match, quote, rawUrl) => {
    const abs = toAbsolute(rawUrl, baseUrl);
    if (!abs || !abs.startsWith("http")) return match;
    return `@import ${quote}${proxyUrl(abs)}${quote}`;
  });

  return css;
}

/** Rewrite HTML: all asset references + inline CSS */
function rewriteHTML(html, baseUrl) {
  if (!html || typeof html !== "string") return html;

  // 1. Rewrite src, href, action, data-src, poster
  html = html.replace(
    /(\s)(src|href|action|data-src|data-href|poster)\s*=\s*(["'])(.*?)\3/gi,
    (match, space, attr, quote, val) => {
      const abs = toAbsolute(val, baseUrl);
      if (!abs || !abs.startsWith("http")) return match;
      return `${space}${attr}=${quote}${proxyUrl(abs)}${quote}`;
    }
  );

  // 2. Rewrite srcset (comma-separated list of url [descriptor])
  html = html.replace(
    /(\s)(srcset)\s*=\s*(["'])(.*?)\3/gi,
    (match, space, attr, quote, val) => {
      const rewritten = val.replace(/([^\s,]+)(\s+[\d.]+[wx])?/g, (m, u, descriptor) => {
        const abs = toAbsolute(u.trim(), baseUrl);
        if (!abs || !abs.startsWith("http")) return m;
        return proxyUrl(abs) + (descriptor || "");
      });
      return `${space}${attr}=${quote}${rewritten}${quote}`;
    }
  );

  // 3. Rewrite inline style attributes
  html = html.replace(
    /(\sstyle\s*=\s*)(["'])(.*?)\2/gi,
    (match, attr, quote, style) => `${attr}${quote}${rewriteCSS(style, baseUrl)}${quote}`
  );

  // 4. Rewrite <style> blocks
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (match, open, css, close) => `${open}${rewriteCSS(css, baseUrl)}${close}`
  );

  // 5. Remove CSP and X-Frame-Options meta tags
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["'](content-security-policy|x-frame-options)["'][^>]*\/?>/gi,
    ""
  );

  // 6. Inject navigation interceptor + URL reporter
  const injected = `<script>
(function() {
  function interceptClicks(e) {
    var el = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      var abs = new URL(href, '${baseUrl}').href;
      window.top.postMessage({ type: 'proxy-navigate', url: abs }, '*');
    } catch(ex) {}
  }
  document.addEventListener('click', interceptClicks, true);
  try { window.top.postMessage({ type: 'proxy-url', url: '${baseUrl}' }, '*'); } catch(ex) {}
})();
</script>`;

  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, injected + "</body>");
  } else {
    html += injected;
  }

  return html;
}

// ── Proxy fetch route ─────────────────────────────────────────────────────────

app.get("/proxy/fetch", async (req, res) => {
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

    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Referer": parsedUrl.origin,
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    const contentType = response.headers.get("content-type") || "";
    const contentLength = parseInt(response.headers.get("content-length") || "0");

    if (contentLength > PROXY_CONFIG.maxResponseSize)
      return res.status(413).json({ error: "Response too large" });

    // Strip security headers, add permissive ones
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.removeHeader("Cross-Origin-Embedder-Policy");
    res.removeHeader("Cross-Origin-Opener-Policy");
    res.removeHeader("Cross-Origin-Resource-Policy");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Forward safe headers
    ["content-type", "cache-control", "last-modified", "etag"].forEach((h) => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    // HTML
    if (contentType.includes("text/html")) {
      const html = await response.text();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(rewriteHTML(html, url));
    }

    // CSS
    if (contentType.includes("text/css")) {
      const css = await response.text();
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      return res.send(rewriteCSS(css, url));
    }

    // JS — pass through as-is
    if (contentType.includes("javascript")) {
      const js = await response.text();
      res.setHeader("Content-Type", contentType);
      return res.send(js);
    }

    // Binary (images, fonts, etc.)
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > PROXY_CONFIG.maxResponseSize)
      return res.status(413).json({ error: "Response too large" });
    return res.send(Buffer.from(buffer));

  } catch (err) {
    if (err.name === "AbortError")
      return res.status(504).json({ error: "Request timed out" });
    console.error("[Proxy error]", err);
    return res.status(502).json({ error: "Failed to fetch URL", detail: err.cause?.message || err.message });
  }
});

// Serve proxy UI
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

function saveBans() {
  fs.writeFileSync(bansFile, JSON.stringify(bannedIPs, null, 2));
}
function saveUsers() {
  fs.writeFileSync(usersFile, JSON.stringify(registeredUsers, null, 2));
}

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
  return (
    typeof color === "string" &&
    /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.test(color)
  );
}

function isValidUsername(name) {
  return (
    typeof name === "string" &&
    name.length >= 2 &&
    name.length <= 18 &&
    /^[\x21-\x7E]+$/.test(name)
  );
}

function isRateLimited(socketId) {
  const now = Date.now();
  const WINDOW_MS = 5000;
  const MAX_MSGS = 8;

  if (!rateLimitMap[socketId]) {
    rateLimitMap[socketId] = { count: 1, windowStart: now };
    return false;
  }

  const state = rateLimitMap[socketId];
  if (now - state.windowStart > WINDOW_MS) {
    state.count = 1;
    state.windowStart = now;
    return false;
  }

  state.count++;
  return state.count > MAX_MSGS;
}

function getRoomUsers(port) {
  return Object.values(users)
    .filter((u) => u.port === port)
    .map((u) => ({ name: u.name, profilePic: u.profilePic, color: u.color }));
}

function safe(fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error("Socket handler error:", err);
    }
  };
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

const LEET_MAP = {
  "4": "a", "@": "a", "8": "b", "3": "e", "6": "g",
  "1": "i", "!": "i", "0": "o", "5": "s", "$": "s", "7": "t",
};

function normalizeForFilter(text) {
  if (!text) return "";
  let s = text.toLowerCase();
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[4836!105$7@]/g, (c) => LEET_MAP[c] || c);
  s = s.replace(/[^a-z]/g, "");
  return s;
}

function filterMessage(text) {
  if (!text || typeof text !== "string") return { allowed: true };

  const raw = text.toLowerCase();
  const stripped = normalizeForFilter(text);

  const wordMatch = (word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z])${escaped}(?![a-z])`).test(raw);
  };

  const obfuscatedMatch = (word) => stripped.includes(normalize(word));

  for (const w of profanityWords) {
    if (wordMatch(normalize(w)) || obfuscatedMatch(w))
      return { allowed: false, reason: "Watch your language." };
  }
  for (const w of sexualWords) {
    if (wordMatch(normalize(w)) || obfuscatedMatch(w))
      return { allowed: false, reason: "Keep it clean." };
  }
  for (const w of slurWords) {
    if (wordMatch(normalize(w)) || obfuscatedMatch(w))
      return { allowed: false, reason: "Hate speech is not allowed." };
  }

  return { allowed: true };
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  const ip = getClientIP(socket);

  if (bannedIPs[ip]) {
    socket.emit("banned", { by: "server" });
    return socket.disconnect(true);
  }

  socket.on("login", safe(({ name, password, port, profilePic, color }) => {
    if (!isValidUsername(name))
      return socket.emit("loginResult", { success: false, message: "Username must be 2–18 printable characters." });
    if (!password || typeof password !== "string")
      return socket.emit("loginResult", { success: false, message: "Password is required." });
    if (!port || typeof port !== "string" || port.trim() === "")
      return socket.emit("loginResult", { success: false, message: "Server port is required." });

    const safeColor = isValidColor(color) ? color : "rgb(255,255,255)";
    const hashed = hashPassword(password);

    if (registeredUsers[name]) {
      if (!safeEqual(registeredUsers[name].password, hashed))
        return socket.emit("loginResult", { success: false, message: "Incorrect password." });
      if (profilePic && typeof profilePic === "string")
        registeredUsers[name].profilePic = profilePic;
      registeredUsers[name].color = safeColor;
      saveUsers();
    } else {
      registeredUsers[name] = {
        password: hashed,
        profilePic: typeof profilePic === "string" ? profilePic : "",
        color: safeColor,
      };
      saveUsers();
      console.log(`Registered new user: ${name}`);
    }

    users[socket.id] = {
      name, ip, socket,
      port: port.trim(),
      profilePic: registeredUsers[name].profilePic,
      color: safeColor,
    };

    socket.join(port.trim());
    io.to(port.trim()).emit("user list", getRoomUsers(port.trim()));
    socket.emit("loginResult", { success: true });
    console.log(`${name} joined room ${port.trim()} from ${ip}`);
  }));

  socket.on("chat message", safe((msg) => {
    const sender = users[socket.id];
    if (!sender) return;
    if (msg.image && msg.image.length > 2_000_000) return;
    if (isRateLimited(socket.id)) {
      socket.emit("chatBlocked", { reason: "Slow down — you're sending messages too fast." });
      return;
    }
    if (msg.text !== undefined && msg.text !== null) {
      if (typeof msg.text !== "string") return;
      if (msg.text.length > 600) {
        socket.emit("chatBlocked", { reason: "Message too long (max 600 characters)." });
        return;
      }
      const filter = filterMessage(msg.text);
      if (!filter.allowed) {
        socket.emit("chatBlocked", { reason: filter.reason });
        return;
      }
    }
    const payload = {
      id: crypto.randomUUID(),
      user: sender.name,
      text: msg.text || null,
      image: msg.image || null,
      profilePic: sender.profilePic,
      color: sender.color,
      timestamp: Date.now(),
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
    if (!user) return;
    if (!isValidColor(newColor)) return;
    user.color = newColor;
    if (registeredUsers[user.name]) {
      registeredUsers[user.name].color = newColor;
      saveUsers();
    }
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
