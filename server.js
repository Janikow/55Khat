// server.js (with /ban command + IP banlist)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', true); // IMPORTANT if behind proxy/load balancer
app.use(express.static("public"));

const BANLIST_FILE = path.join(__dirname, 'ip_bans.json');

// Load/save banlist
function loadBanlist() {
  try {
    return new Set(JSON.parse(fs.readFileSync(BANLIST_FILE, 'utf8')));
  } catch (e) {
    return new Set();
  }
}
function saveBanlist(set) {
  try { fs.writeFileSync(BANLIST_FILE, JSON.stringify(Array.from(set)), 'utf8'); }
  catch (e) { console.error("Failed to save banlist:", e); }
}
const banlist = loadBanlist();

/**
 * users: socket.id -> { name: string, ip: string }
 */
let users = {};

// Helpers
function normalizeIp(ip) {
  if (!ip) return "";
  if (typeof ip !== "string") ip = String(ip);
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
  return ip;
}

function maskIp(ip) {
  if (!ip) return "";
  const ipv4 = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (ipv4) return `${ipv4[1]}.xxx`;
  const ipv6Parts = ip.split(":");
  if (ipv6Parts.length >= 4) return `${ipv6Parts.slice(0,3).join(":")}:xxxx`;
  return ip;
}

function broadcastUserList() {
  const publicList = Object.values(users).map(u => ({ name: u.name, ipMasked: maskIp(u.ip) }));
  io.emit("user list", publicList);
}

// Middleware-style check: when a socket first connects, reject if IP banned
io.use((socket, next) => {
  const headers = socket.handshake.headers || {};
  const rawIp = headers['x-forwarded-for'] || headers['cf-connecting-ip'] || socket.handshake.address;
  const clientIp = normalizeIp(rawIp);
  if (banlist.has(clientIp)) {
    // Optionally include a reason or timestamp
    const err = new Error('ip_banned');
    err.data = { code: 'IP_BANNED' };
    return next(err); // socket will get an error and not connect
  }
  // attach computed ip for later handlers
  socket.clientIp = clientIp;
  return next();
});

io.on("connection", (socket) => {
  // socket.clientIp was set in io.use
  const clientIp = socket.clientIp || normalizeIp(socket.handshake.address || '');
  console.log(`A user connected: socket=${socket.id} ip=${clientIp}`);

  // Send a welcome (optional)
  socket.emit('system', { text: 'Connected to server.' });

  socket.on("join", (name) => {
    // store user info
    users[socket.id] = { name: name || "Unnamed", ip: clientIp };
    console.log(`${name} joined from ${clientIp}`);

    // send masked user list to new user and everyone
    broadcastUserList();
  });

  socket.on("chat message", (msg) => {
    // If the message is a command and the sender is allowed, handle it
    const sender = users[socket.id];
    if (!sender) return; // safety

    if (typeof msg.text === 'string' && msg.text.trim().startsWith('/')) {
      const parts = msg.text.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();

      // /ban <username>
      if (cmd === '/ban' && sender.name === 'TemMoose') {
        const targetName = parts.slice(1).join(' ').trim();
        if (!targetName) {
          socket.emit('system', { text: 'Usage: /ban <username>' });
          return;
        }

        // Find all sockets with that username
        const targets = Object.entries(users).filter(([sid, u]) => u.name === targetName);
        if (targets.length === 0) {
          socket.emit('system', { text: `User "${targetName}" not found.` });
          return;
        }

        // Ban each unique IP for matched users
        const bannedIps = new Set();
        targets.forEach(([sid, u]) => {
          const ipToBan = normalizeIp(u.ip);
          if (ipToBan) {
            bannedIps.add(ipToBan);
            banlist.add(ipToBan);
          }

          // Notify & disconnect the target socket
          const targetSocket = io.sockets.sockets.get(sid);
          if (targetSocket) {
            // send a 'banned' event so client can show message / redirect
            targetSocket.emit('banned', { by: sender.name, ip: maskIp(u.ip) });
            // then forcibly disconnect
            try { targetSocket.disconnect(true); }
            catch (e) { console.warn('Failed to disconnect target socket', e); }
          }

          // cleanup server-side users map
          delete users[sid];
        });

        // Persist banlist
        saveBanlist(banlist);

        // Broadcast a system message saying the user was banned (optional)
        const reasonText = `User "${targetName}" was IP-banned by ${sender.name}.`;
        io.emit('chat message', { user: 'System', text: reasonText });

        // send feedback to the admin who issued the ban
        socket.emit('system', { text: `Banned IPs: ${Array.from(bannedIps).join(', ')}` });

        // update user lists
        broadcastUserList();
        return;
      }

      // Add other admin commands here (e.g., /tempban, /unban) similarly...
    }

    // Normal chat flow
    console.log(`[${msg.user}] ${msg.text}`);
    io.emit("chat message", msg);
  });

  socket.on("disconnect", (reason) => {
    if (users[socket.id]) {
      console.log(`${users[socket.id].name} disconnected (ip: ${users[socket.id].ip}) reason=${reason}`);
      delete users[socket.id];
      broadcastUserList();
    } else {
      console.log(`Unknown socket disconnected: ${socket.id} reason=${reason}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


