const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024, // 2MB limit
  pingTimeout: 20000,
  pingInterval: 10000,
});

app.use(express.static("public"));

// ─── Proxy ────────────────────────────────────────────────────────────────────

// Use built-in fetch (Node 18+) or install node-fetch for older versions
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
  maxResponseSize: 10 * 1024 * 1024, // 10MB
  timeout: 15000,
};

function isBlockedDomain(url) {
  try {
    const { hostname } = new URL(url);
    return PROXY_CONFIG.blockedDomains.some((b) => hostname.includes(b));
  } catch {
    return true;
  }
}

function resolveRelativeUrls(html, baseUrl) {
  try {
    const base = new URL(baseUrl);
    return html
      .replace(
        /(href|src|action)=["'](https?:\/\/[^"']+)["']/gi,
        (_, attr, url) => `${attr}="/proxy/fetch?url=${encodeURIComponent(url)}"`
      )
      .replace(
        /(href|src|action)=["'](\/[^"']+)["']/gi,
        (_, attr, p) => `${attr}="/proxy/fetch?url=${encodeURIComponent(base.origin + p)}"`
      )
      .replace(
        /<head([^>]*)>/i,
        `<head$1><base href="${baseUrl}"><script>
          document.addEventListener('click', function(e) {
            const a = e.target.closest('a');
            if (a && a.href && !a.href.startsWith('/proxy/')) {
              e.preventDefault();
              window.top.postMessage({ type: 'proxy-navigate', url: a.href }, '*');
            }
          });
        <\/script>`
      );
  } catch {
    return html;
  }
}

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
    const timeout = setTimeout(() => controller.abort(), PROXY_CONFIG.timeout);

    const response = await fetchFn(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WebProxy/1.0)",
        Accept: req.headers.accept || "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    const contentType = response.headers.get("content-type") || "";
    const contentLength = parseInt(response.headers.get("content-length") || "0");

    if (contentLength > PROXY_CONFIG.maxResponseSize)
      return res.status(413).json({ error: "Response too large" });

    ["content-type", "cache-control", "last-modified", "etag"].forEach((h) => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "");

    if (contentType.includes("text/html")) {
      let html = await response.text();
      html = resolveRelativeUrls(html, url);
      html = html.replace(
        "</body>",
        `<script>
          try { window.top.postMessage({ type: 'proxy-url', url: '${url}' }, '*'); } catch(e) {}
        <\/script></body>`
      );
      return res.send(html);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > PROXY_CONFIG.maxResponseSize)
      return res.status(413).json({ error: "Response too large" });
    return res.send(Buffer.from(buffer));

  } catch (err) {
    if (err.name === "AbortError")
      return res.status(504).json({ error: "Request timed out" });
    console.error("[Proxy error]", err.message);
    return res.status(502).json({ error: "Failed to fetch URL", detail: err.message });
  }
});

// Serve the proxy UI at /proxy
app.get("/proxy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "websurf.html"));
});

// ─── Auto Ping ────────────────────────────────────────────────────────────────

const https = require("https");
const URL_PING = "https://clevereducation.online/";

function ping() {
  https.get(URL_PING, (res) => {
    console.log(`Pinged! Status: ${res.statusCode}`);
  }).on("error", (err) => {
    console.log("Error:", err.message);
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

const profanitySet = profanityWords.map(normalize);
const slurSet = slurWords.map(normalize);
const sexualSet = sexualWords.map(normalize);

// ─── Normalisation ────────────────────────────────────────────────────────────

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

  socket.on(
    "login",
    safe(({ name, password, port, profilePic, color }) => {
      if (!isValidUsername(name))
        return socket.emit("loginResult", {
          success: false,
          message: "Username must be 2–18 printable characters.",
        });
      if (!password || typeof password !== "string")
        return socket.emit("loginResult", {
          success: false,
          message: "Password is required.",
        });
      if (!port || typeof port !== "string" || port.trim() === "")
        return socket.emit("loginResult", {
          success: false,
          message: "Server port is required.",
        });

      const safeColor = isValidColor(color) ? color : "rgb(255,255,255)";
      const hashed = hashPassword(password);

      if (registeredUsers[name]) {
        if (!safeEqual(registeredUsers[name].password, hashed))
          return socket.emit("loginResult", {
            success: false,
            message: "Incorrect password.",
          });
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
        name,
        ip,
        socket,
        port: port.trim(),
        profilePic: registeredUsers[name].profilePic,
        color: safeColor,
      };

      socket.join(port.trim());
      io.to(port.trim()).emit("user list", getRoomUsers(port.trim()));
      socket.emit("loginResult", { success: true });
      console.log(`${name} joined room ${port.trim()} from ${ip}`);
    })
  );

  socket.on(
    "chat message",
    safe((msg) => {
      const sender = users[socket.id];
      if (!sender) return;

      if (msg.image && msg.image.length > 2_000_000) return;

      if (isRateLimited(socket.id)) {
        socket.emit("chatBlocked", {
          reason: "Slow down — you're sending messages too fast.",
        });
        return;
      }

      if (msg.text !== undefined && msg.text !== null) {
        if (typeof msg.text !== "string") return;
        if (msg.text.length > 600) {
          socket.emit("chatBlocked", {
            reason: "Message too long (max 600 characters).",
          });
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
    })
  );

  socket.on(
    "typing",
    safe((isTyping) => {
      const user = users[socket.id];
      if (!user) return;
      socket.to(user.port).emit("typing", {
        user: user.name,
        isTyping: Boolean(isTyping),
      });
    })
  );

  socket.on(
    "colorChange",
    safe((newColor) => {
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
    })
  );

  socket.on(
    "disconnect",
    safe(() => {
      const user = users[socket.id];
      if (user) {
        console.log(`${user.name} disconnected from room ${user.port}`);
        const port = user.port;
        delete users[socket.id];
        delete rateLimitMap[socket.id];
        io.to(port).emit("user list", getRoomUsers(port));
      }
    })
  );
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
