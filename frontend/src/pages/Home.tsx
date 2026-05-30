import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { DecodedEvent } from "../api";
import EventTable from "../components/EventTable";
import { useEventStream } from "../hooks/useEventStream";

const FUNCTIONS = ["", "swap", "transfer", "mint", "burn", "stake", "unstake", "wrap_native", "unwrap_native"];

// Issue #48 — transaction type filter
type TxType = "all" | "soroban" | "classic";

const TYPE_LABELS: { key: TxType; label: string; title: string }[] = [
  { key: "all",     label: "All Transactions",       title: "Show all transaction types" },
  { key: "soroban", label: "Soroban Only",            title: "Contract deployments and invocations only" },
  { key: "classic", label: "Classic Operations Only", title: "Payments, offers, and other classic ops" },
];

export default function Home() {
  const [fnFilter, setFnFilter] = useState("");
  const [page, setPage] = useState(1);
  const [txType, setTxType] = useState<TxType>("all");

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["events", fnFilter, page, txType],
    queryFn: () => api.events({
      fn:   fnFilter || undefined,
      page,
      type: txType !== "all" ? txType : undefined,
    }),
  });

  // Issue #39 — invalidate the event list when a live event arrives on page 1
  const handleLiveEvent = useCallback((ev: DecodedEvent) => {
    setLiveCount(c => c + 1);
    if (page === 1 && (!fnFilter || ev.function === fnFilter)) {
      queryClient.invalidateQueries({ queryKey: ["events", fnFilter, 1] });
    }
  }, [page, fnFilter, queryClient]);

  useEventStream(handleLiveEvent);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Soroban Smart Block Explorer</h1>
        <p style={{ color: "var(--muted)" }}>Human-readable Soroban contract events on Stellar.</p>
      </div>

      {/* Filters row */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        {/* Issue #48 — type toggle */}
        <div style={{ display: "flex", gap: 0, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
          {TYPE_LABELS.map(({ key, label, title }) => (
            <button
              key={key}
              title={title}
              onClick={() => { setTxType(key); setPage(1); }}
              style={{
                background: txType === key ? "var(--accent)" : "var(--surface)",
                color: txType === key ? "#0d1117" : "var(--muted)",
                borderRadius: 0,
                padding: "6px 14px",
                fontWeight: txType === key ? 700 : 400,
                borderRight: "1px solid var(--border)",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Function filter */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: "var(--muted)" }}>Function:</label>
          <select value={fnFilter} onChange={e => { setFnFilter(e.target.value); setPage(1); }}>
            {FUNCTIONS.map(f => <option key={f} value={f}>{f || "All"}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        {isLoading
          ? <p style={{ color: "var(--muted)" }}>Loading…</p>
          : <EventTable events={events} />}
      </div>

      {/* Pagination */}
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
        <span style={{ padding: "6px 10px", color: "var(--muted)" }}>Page {page}</span>
        <button disabled={events.length < 25} onClick={() => setPage(p => p + 1)}>Next →</button>
      </div>
    </div>
  );
}
