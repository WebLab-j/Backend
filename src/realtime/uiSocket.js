"use strict";

let ioRef = null;

function initUiSocket(httpServer, { corsOrigins = [] } = {}) {
  const { Server } = require("socket.io");

  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigins.length ? corsOrigins : true,
      credentials: true,
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    socket.join("all_days"); // ← agrega esta línea

    // el front se suscribe a días específicos para no spamear
    socket.on("subscribe_day", ({ day }) => {
      if (day) socket.join(`day:${day}`);
    });

    socket.on("unsubscribe_day", ({ day }) => {
      if (day) socket.leave(`day:${day}`);
    });

    // opcional: room por usuario
    socket.on("subscribe_user", ({ userId }) => {
      if (userId) socket.join(`user:${userId}`);
    });

    socket.on("unsubscribe_user", ({ userId }) => {
      if (userId) socket.leave(`user:${userId}`);
    });
  });

  ioRef = io;
  return io;
}

function emitDayUpdate(day, payload) {
  if (!ioRef || !day) return;
  ioRef.to(`day:${day}`).emit("day_update", payload);
  ioRef.to("all_days").emit("day_update", payload); // ← todos los eventos
}

function emitUserNotification(userId, payload) {
  if (!ioRef || !userId) return;
  ioRef.to(`user:${userId}`).emit("notify", payload);
}

function emitBroadcast(event, payload) {
  if (!ioRef) return;
  ioRef.emit(event, payload);
}

module.exports = {
  initUiSocket,
  emitDayUpdate,
  emitUserNotification,
  emitBroadcast,
};
