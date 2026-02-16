"use strict";

/**
 * WL Socket Listener
 *
 * Conecta a un Socket.IO remoto y expone eventos de revisiones.
 *
 * Requisitos:
 *   npm i socket.io-client
 *
 * ENV:
 *   WL_SOCKET_URL=https://wlserver-production-6735.up.railway.app
 */

const { io } = require("socket.io-client");

function startWlSocketListener({
  socketUrl,
  handleEvent,
  logger = console,
  events = ["revision_creada", "revision_actualizada", "revision_eliminada"],
  socketOptions = {},
} = {}) {
  if (!socketUrl) throw new Error("startWlSocketListener: socketUrl is required");
  if (typeof handleEvent !== "function") {
    throw new Error("startWlSocketListener: handleEvent(eventName, payload, meta) is required");
  }

  const socket = io(socketUrl, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10000,
    ...socketOptions,
  });

  socket.on("connect", () => logger.log(`[wlSocketListener] connected ${socket.id}`));
  socket.on("disconnect", (reason) => logger.warn(`[wlSocketListener] disconnected: ${reason}`));
  socket.on("connect_error", (err) =>
    logger.error("[wlSocketListener] connect_error:", err?.message || err),
  );

  for (const eventName of events) {
    socket.on(eventName, (payload) => {
      const meta = {
        ts: new Date().toISOString(),
        socketId: socket.id || null,
        socketUrl,
      };

      try {
        handleEvent(eventName, payload, meta);
      } catch (err) {
        logger.error(`[wlSocketListener] handleEvent failed for ${eventName}:`, err?.message || err);
      }
    });
  }

  return socket;
}

module.exports = { startWlSocketListener };
