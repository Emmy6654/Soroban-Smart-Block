/**
 * Live Event Streaming via WebSockets  (Issue #39)
 *
 * Uses Node's built-in EventEmitter as the pub/sub bus (no Redis required).
 * The HTTP server is upgraded to handle WebSocket connections via the `ws`
 * package.  When the indexer stores a new event it calls `publish(event)` and
 * every connected client receives the payload within the same event-loop tick.
 */

import { EventEmitter } from "events";
import { WebSocketServer } from "ws";

// Internal pub/sub bus — shared across the process
const bus = new EventEmitter();
bus.setMaxListeners(0); // allow unlimited subscribers

/** Publish a decoded event to all connected WebSocket clients. */
export function publish(event) {
  bus.emit("event", event);
}

/**
 * Attach a WebSocket server to an existing HTTP server instance.
 *
 * @param {import("http").Server} httpServer
 */
export function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    console.log("[ws] Client connected");

    // Forward every published event to this client
    const handler = (event) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "event", data: event }));
      }
    };

    bus.on("event", handler);

    ws.on("close", () => {
      bus.off("event", handler);
      console.log("[ws] Client disconnected");
    });

    ws.on("error", (err) => {
      console.error("[ws] Socket error:", err.message);
      bus.off("event", handler);
    });

    // Acknowledge connection
    ws.send(JSON.stringify({ type: "connected", message: "Soroban event stream ready" }));
  });

  console.log("[ws] WebSocket server attached");
  return wss;
}
