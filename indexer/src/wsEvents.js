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

/** Publish a vault conversion-ratio update to all connected WebSocket clients. */
export function publishVaultRatio(snapshot) {
  bus.emit("vault_ratio", {
    contract_id:  snapshot.contract_id,
    ratio:        snapshot.ratio,
    total_assets: snapshot.total_assets,
    total_supply: snapshot.total_supply,
    ledger:       snapshot.ledger,
  });
}

/** Publish a TVL update to all connected WebSocket clients. */
export function publishTVL(tvl) {
  bus.emit("tvl", {
    protocol:       tvl.protocol,
    tvl_raw:        tvl.tvl_raw,
    token_breakdown: tvl.token_breakdown,
    pool_count:     tvl.pool_count,
  });
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

    // Forward vault ratio updates
    const vaultHandler = (snapshot) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "vault_ratio", data: snapshot }));
      }
    };

    // Forward TVL updates
    const tvlHandler = (tvl) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "tvl", data: tvl }));
      }
    };

    bus.on("event", handler);
    bus.on("vault_ratio", vaultHandler);
    bus.on("tvl", tvlHandler);

    ws.on("close", () => {
      bus.off("event", handler);
      bus.off("vault_ratio", vaultHandler);
      bus.off("tvl", tvlHandler);
      console.log("[ws] Client disconnected");
    });

    ws.on("error", (err) => {
      console.error("[ws] Socket error:", err.message);
      bus.off("event", handler);
      bus.off("vault_ratio", vaultHandler);
      bus.off("tvl", tvlHandler);
    });

    // Acknowledge connection
    ws.send(JSON.stringify({ type: "connected", message: "Soroban event stream ready" }));
  });

  console.log("[ws] WebSocket server attached");
  return wss;
}
