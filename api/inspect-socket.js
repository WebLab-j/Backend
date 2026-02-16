// inspect-socket.js
"use strict";

const { io } = require("socket.io-client");

const URL = process.env.WL_SOCKET_URL; // ej: https://wlserver-production-6735.up.railway.app
if (!URL) throw new Error("Set WL_SOCKET_URL");

const socket = io(URL, { transports: ["websocket", "polling"] });

function log(event, payload) {
  console.log("\n== EVENT:", event, "==", new Date().toISOString());
  console.log(JSON.stringify(payload, null, 2));
}

socket.on("connect", () => console.log("connected:", socket.id));

socket.on("revision_creada", (p) => log("revision_creada", p));
socket.on("revision_actualizada", (p) => log("revision_actualizada", p));
socket.on("revision_eliminada", (p) => log("revision_eliminada", p));
