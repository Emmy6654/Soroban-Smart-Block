import express from "express";
import http from "http";
import { db } from "./db.js";
import { fetchTokenMetadata } from "./sep41Metadata.js";
import { attachWebSocketServer } from "./wsEvents.js";
import { bootstrapVault, refreshVaultRatio } from "./vaultIndexer.js";

const PORT = process.env.PORT || 3001;
const VERIFY_ON_UPLOAD = process.env.VERIFY_ABI !== "false";
const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

export function startApi() {
  const app = express();
  app.use(express.json());

  // ── Existing endpoints ──────────────────────────────────────────────────────

  // GET /api/events?contract=&fn=&page=
  app.get("/api/events", async (req, res) => {
    try {
      const events = await db.getEvents({
        contract: req.query.contract,
        fn:       req.query.fn,
        page:     Number(req.query.page) || 1,
        type:     req.query.type,
      });
      res.json(events);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/events/:seq
  app.get("/api/events/:seq", async (req, res) => {
    try {
      const ev = await db.getEvent(Number(req.params.seq));
      if (!ev) return res.status(404).json({ error: "Not found" });
      res.json(ev);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/contracts/:id
  app.get("/api/contracts/:id", async (req, res) => {
    try {
      const meta = await db.getContractMeta(req.params.id);
      if (!meta) return res.status(404).json({ error: "Not found" });
      res.json(meta);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/contracts/:id/abi — download standardized ABI JSON
  app.get("/api/contracts/:id/abi", async (req, res) => {
    try {
      const { fetchContractSpec } = await import("./verify_abi.js");
      const meta = await db.getContractMeta(req.params.id);
      const spec = await fetchContractSpec(req.params.id);
      const abi = {
        contractId: req.params.id,
        name: meta?.name || "",
        description: meta?.description || "",
        functions: (spec || []).map(fn => {
          const registered = meta?.functions?.find(f => f.name === fn.name);
          return {
            name: fn.name,
            description: registered?.description || "",
            args: fn.args.map(a => ({ name: a.name, type: a.type })),
          };
        }),
      };
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}.abi.json"`);
      res.json(abi);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/contracts  — register ABI metadata
  app.post("/api/contracts", async (req, res) => {
    try {
      const { id, functions } = req.body;

      if (!id || !functions) {
        return res.status(400).json({ error: "Missing id or functions" });
      }

      // Verify ABI against on-chain spec if enabled
      if (VERIFY_ON_UPLOAD) {
        const verification = await verifyAbi(id, functions);

        if (!verification.valid) {
          return res.status(400).json({
            error: "ABI verification failed",
            details: verification,
          });
        }

        console.log(`ABI verified for contract ${id}:`, {
          functionsVerified: functions.length,
          missing: verification.missingFunctions.length,
          mismatches: verification.argMismatch.length,
        });
      }

      await db.upsertContractMeta(req.body);
      res.status(201).json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/verify — verify ABI without registering
  app.post("/api/verify", async (req, res) => {
    try {
      const { contractId, functions } = req.body;

      if (!contractId || !functions) {
        return res.status(400).json({ error: "Missing contractId or functions" });
      }

      const verification = await verifyAbi(contractId, functions);
      res.json(verification);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/spec/:id — fetch on-chain spec for a contract
  app.get("/api/spec/:id", async (req, res) => {
    try {
      const { fetchContractSpec } = await import("./verify_abi.js");
      const spec = await fetchContractSpec(req.params.id);
      if (spec === null) {
        return res.status(404).json({ error: "Contract not found or has no spec" });
      }
      res.json(spec);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/simulate — issue #46: simulate a contract call via RPC
  app.post("/api/simulate", async (req, res) => {
    try {
      const { contractId, fn, args = [] } = req.body;
      if (!contractId || !fn) return res.status(400).json({ error: "Missing contractId or fn" });

      const { SorobanRpc, Contract, nativeToScVal, xdr } = await import("@stellar/stellar-sdk");
      const rpcUrl = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
      const server = new SorobanRpc.Server(rpcUrl);

      const contract = new Contract(contractId);
      const scArgs = args.map(a => nativeToScVal(a));
      const op = contract.call(fn, ...scArgs);

      const account = await server.getAccount(process.env.SIMULATE_SOURCE || "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN");
      const { TransactionBuilder, Networks, BASE_FEE } = await import("@stellar/stellar-sdk");
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);

      if (SorobanRpc.Api.isSimulationError(sim)) {
        return res.json({ success: false, error: sim.error });
      }

      const cost = sim.cost ?? {};
      const retVal = sim.result?.retval;
      res.json({
        success: true,
        returnValue: retVal ? retVal.toXDR("base64") : undefined,
        cost: { cpuInsns: String(cost.cpuInsns ?? 0), memBytes: String(cost.memBytes ?? 0) },
      });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // GET /api/wallet/:address
  app.get("/api/wallet/:address", async (req, res) => {
    try {
      const events = await db.getWalletEvents(req.params.address);
      res.json(events);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/tokens/:id/volume  — 24-hour rolling transfer volume
  app.get("/api/tokens/:id/volume", async (req, res) => {
    try {
      const contractId = req.params.id;
      // Fetch decimals from on-chain metadata (cached via contract registry or live sim)
      let decimals = 7;
      try {
        const meta = await fetchTokenMetadata(contractId);
        decimals = meta.decimals;
      } catch { /* use default */ }

      const volume = await db.get24hVolume(contractId, decimals);
      res.json({ contract_id: contractId, window: "24h", ...volume });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Issue #38: Contract transaction history ─────────────────────────────────
  // GET /api/v1/contracts/:id/transactions?function_name=&start_ledger=&end_ledger=&page=&limit=
  app.get("/api/v1/contracts/:id/transactions", async (req, res) => {
    try {
      const { function_name, start_ledger, end_ledger, page, limit } = req.query;
      const result = await db.getContractTransactions(req.params.id, {
        function_name: function_name || undefined,
        start_ledger:  start_ledger  ? Number(start_ledger)  : undefined,
        end_ledger:    end_ledger    ? Number(end_ledger)    : undefined,
        page:          page          ? Number(page)          : 1,
        limit:         limit         ? Math.min(Number(limit), 100) : 25,
      });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Vault indexer endpoints ─────────────────────────────────────────────────

  // POST /api/vaults — register a vault to monitor
  app.post("/api/vaults", async (req, res) => {
    try {
      const { contract_id, name, decimals } = req.body;
      if (!contract_id) return res.status(400).json({ error: "Missing contract_id" });

      await db.registerVault({ contract_id, name: name ?? null, decimals: decimals ?? 7 });

      // Bootstrap: discover underlying asset, take initial snapshot
      bootstrapVault(contract_id).catch(err =>
        console.error(`[vault] Bootstrap error for ${contract_id}: ${err.message}`)
      );

      res.status(201).json({ ok: true, contract_id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/vaults — list all monitored vaults
  app.get("/api/vaults", async (req, res) => {
    try {
      const vaults = await db.getVaults();
      res.json(vaults);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/vaults/:id — vault detail with latest conversion ratio
  app.get("/api/vaults/:id", async (req, res) => {
    try {
      const vault = await db.getVault(req.params.id);
      if (!vault) return res.status(404).json({ error: "Vault not found" });
      res.json(vault);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/vaults/:id/history — historical ratio snapshots
  app.get("/api/vaults/:id/history", async (req, res) => {
    try {
      const { limit } = req.query;
      const history = await db.getVaultHistory(req.params.id, {
        limit: limit ? Math.min(Number(limit), 1000) : 100,
      });
      res.json(history);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/vaults/:id/refresh — trigger an immediate ratio refresh
  app.post("/api/vaults/:id/refresh", async (req, res) => {
    try {
      const vault = await db.getVault(req.params.id);
      if (!vault) return res.status(404).json({ error: "Vault not found" });

      const { SorobanRpc } = await import("@stellar/stellar-sdk");
      const server = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
      const ledger = (await server.getLatestLedger()).sequence;

      await refreshVaultRatio(req.params.id, ledger);
      const updated = await db.getVault(req.params.id);
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/vaults/:id — unregister a vault
  app.delete("/api/vaults/:id", async (req, res) => {
    try {
      await db.unregisterVault(req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Start HTTP + WebSocket server ───────────────────────────────────────────
  const server = http.createServer(app);
  attachWebSocketServer(server);                // Issue #39
  server.listen(PORT, () => console.log(`API listening on :${PORT}`));
  return server;
}
