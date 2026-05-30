/**
 * Issue #40 — ResourceCosts
 * Displays Soroban resource consumption breakdown for a single event.
 */
import type { DecodedEvent } from "../api";

export default function ResourceCosts({ event }: { event: DecodedEvent }) {
  const { cpu_instructions, mem_bytes, fee_charged } = event;
  if (cpu_instructions == null && mem_bytes == null && fee_charged == null) return null;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h4 style={{ marginBottom: 10, fontSize: 13 }}>Resource Consumption</h4>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
        {cpu_instructions != null && (
          <ResourceTile label="CPU Instructions" value={cpu_instructions.toLocaleString()} unit="ops" />
        )}
        {mem_bytes != null && (
          <ResourceTile label="Memory" value={mem_bytes.toLocaleString()} unit="bytes" />
        )}
        {fee_charged != null && (
          <ResourceTile label="Fee Charged" value={(fee_charged / 1e7).toFixed(7)} unit="XLM" />
        )}
      </div>
    </div>
  );
}

function ResourceTile({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{
      background: "var(--surface, #1a1a2e)",
      borderRadius: 8,
      padding: "10px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
    }}>
      <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </span>
      <span style={{ fontWeight: 600, fontSize: 16 }}>{value}</span>
      <span style={{ fontSize: 11, color: "var(--muted)" }}>{unit}</span>
    </div>
  );
}
