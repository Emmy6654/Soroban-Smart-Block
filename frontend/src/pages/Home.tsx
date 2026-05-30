import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { DecodedEvent } from "../api";
import EventTable from "../components/EventTable";
import { useEventStream } from "../hooks/useEventStream";

const FUNCTIONS = ["", "swap", "transfer", "mint", "burn", "stake", "unstake", "wrap_native", "unwrap_native"];

export default function Home() {
  const [fnFilter, setFnFilter] = useState("");
  const [page, setPage] = useState(1);
  const [liveCount, setLiveCount] = useState(0);
  const queryClient = useQueryClient();

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["events", fnFilter, page],
    queryFn: () => api.events({ fn: fnFilter || undefined, page }),
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
        <p style={{ color: "var(--muted)" }}>
          Human-readable Soroban contract events on Stellar.
          {liveCount > 0 && (
            <span style={{ marginLeft: 10, color: "#4ade80", fontSize: 12 }}>
              ● Live — {liveCount} event{liveCount !== 1 ? "s" : ""} received
            </span>
          )}
        </p>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label style={{ color: "var(--muted)" }}>Filter by function:</label>
        <select value={fnFilter} onChange={e => { setFnFilter(e.target.value); setPage(1); }}>
          {FUNCTIONS.map(f => <option key={f} value={f}>{f || "All"}</option>)}
        </select>
      </div>

      <div className="card">
        {isLoading ? <p style={{ color: "var(--muted)" }}>Loading…</p> : <EventTable events={events} />}
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
