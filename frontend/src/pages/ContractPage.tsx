import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import EventTable from "../components/EventTable";
import RustCodeViewer from "../components/RustCodeViewer";
import SimulateButton from "../components/SimulateButton";
import InvocationFlowChart, { type InvocationNode } from "../components/InvocationFlowChart";

// Demo source shown when no verified source is uploaded
const DEMO_SOURCE = `// Verified source not yet uploaded for this contract.
// Example Soroban contract structure:

use soroban_sdk::{contract, contractimpl, Env, Symbol, Address};

#[contract]
pub struct MyContract;

#[contractimpl]
impl MyContract {
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let mut balance: i128 = env.storage().instance().get(&from).unwrap_or(0);
        balance -= amount;
        env.storage().instance().set(&from, &balance);
    }
}`;

// Demo invocation tree shown when no real trace is available
const DEMO_TREE: InvocationNode = {
  contract: "ContractA",
  fn: "swap",
  children: [
    {
      contract: "ContractB",
      fn: "transfer",
      children: [
        { contract: "ContractC", fn: "update_balance" },
      ],
    },
    { contract: "ContractB", fn: "emit_event" },
  ],
};

type Tab = "overview" | "source" | "simulate" | "flow";

export default function ContractPage() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedFn, setSelectedFn] = useState("");

  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ["contract", id],
    queryFn: () => api.contract(id),
    enabled: !!id,
  });

  const { data: events = [], isLoading: evLoading } = useQuery({
    queryKey: ["events", id],
    queryFn: () => api.events({ contract: id }),
    enabled: !!id,
  });

  const downloadAbi = () => {
    api.downloadAbi(id).catch(err => console.error("Download ABI failed:", err));
  };

  if (metaLoading) return <p style={{ color: "var(--muted)" }}>Loading…</p>;
  if (!meta) return <p>Contract not found.</p>;

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "source",   label: "Source Code" },
    { key: "simulate", label: "Simulate" },
    { key: "flow",     label: "Invocation Flow" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ marginBottom: 8 }}>{meta.name}</h2>
            <p style={{ color: "var(--muted)", marginBottom: 12 }}>{meta.description}</p>
            <code style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>{id}</code>
          </div>
          <button
            onClick={downloadAbi}
            style={{
              padding: "8px 16px",
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Download ABI
          </button>
        </div>

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", paddingBottom: 0 }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: "none",
              color: tab === t.key ? "var(--accent)" : "var(--muted)",
              borderBottom: tab === t.key ? "2px solid var(--accent)" : "2px solid transparent",
              borderRadius: 0,
              padding: "8px 16px",
              fontWeight: tab === t.key ? 700 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Overview */}
      {tab === "overview" && (
        <>
          {meta.functions.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: 8, fontSize: 14 }}>Functions</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {meta.functions.map(f => (
                  <div key={f.name} className="card" style={{ padding: "8px 12px" }}>
                    <span className="badge">{f.name}</span>
                    <span style={{ marginLeft: 8, color: "var(--muted)" }}>{f.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <h3>Recent Events</h3>
          <div className="card">
            {evLoading ? <p style={{ color: "var(--muted)" }}>Loading…</p> : <EventTable events={events} />}
          </div>
        </>
      )}

      {/* Tab: Source Code — Issue #45 */}
      {tab === "source" && (
        <RustCodeViewer
          source={(meta as any).source ?? DEMO_SOURCE}
          filename={(meta as any).source_file ?? `${id.slice(0, 8)}.rs`}
        />
      )}

      {/* Tab: Simulate — Issue #46 */}
      {tab === "simulate" && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h3 style={{ fontSize: 14 }}>Simulate Contract Call</h3>
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            Preview execution results without spending real fees.
          </p>
          {meta.functions.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ color: "var(--muted)" }}>Function:</label>
              <select value={selectedFn} onChange={e => setSelectedFn(e.target.value)}>
                <option value="">— select —</option>
                {meta.functions.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
              </select>
            </div>
          )}
          {selectedFn && (
            <SimulateButton contractId={id} fnName={selectedFn} />
          )}
          {!selectedFn && meta.functions.length === 0 && (
            <SimulateButton contractId={id} fnName="transfer" />
          )}
        </div>
      )}

      {/* Tab: Invocation Flow — Issue #47 */}
      {tab === "flow" && (
        <InvocationFlowChart root={(meta as any).invocation_tree ?? DEMO_TREE} />
      )}
    </div>
  );
}
