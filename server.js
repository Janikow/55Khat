const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let users = {}; // socket.id -> username

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  socket.on("join", (name) => {
    users[socket.id] = name;
    console.log(`${name} joined`);

    // send full list to the new user
    socket.emit("user list", Object.values(users));

    // send updated list to everyone else
    socket.broadcast.emit("user list", Object.values(users));
  });

  socket.on("chat message", (msg) => {
    // log chat to terminal
    console.log(`[${msg.user}] ${msg.text}`);
    io.emit("chat message", msg);
  });

  socket.on("disconnect", () => {
    console.log(`${users[socket.id]} disconnected`);
    delete users[socket.id];
    io.emit("user list", Object.values(users));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
