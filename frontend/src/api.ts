const BASE = "/api";

export interface DecodedEvent {
  seq: number;
  contract_id: string;
  function: string;
  ledger: number;
  description: string;
  raw_topics: string[];
  tx_hash?: string;
  // Issue #40: Soroban resource gas costs
  cpu_instructions?: number;
  mem_bytes?: number;
  fee_charged?: number;
}

export interface ContractMeta {
  id: string;
  name: string;
  description: string;
  functions: { name: string; description: string }[];
}

// Issue #38: paginated contract transaction response
export interface ContractTransactionsResponse {
  data: DecodedEvent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
    has_next: boolean;
  };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

export interface SimResult {
  success: boolean;
  returnValue?: string;
  cost?: { cpuInsns: string; memBytes: string };
  error?: string;
}

export const api = {
  events: (params: { contract?: string; fn?: string; page?: number; type?: string }) => {
    const q = new URLSearchParams();
    if (params.contract) q.set("contract", params.contract);
    if (params.fn)       q.set("fn", params.fn);
    if (params.page)     q.set("page", String(params.page));
    if (params.type)     q.set("type", params.type);
    return get<DecodedEvent[]>(`/events?${q}`);
  },
  event:    (seq: number)     => get<DecodedEvent>(`/events/${seq}`),
  contract: (id: string)      => get<ContractMeta>(`/contracts/${id}`),
  wallet:   (address: string) => get<DecodedEvent[]>(`/wallet/${address}`),

  downloadAbi: async (id: string) => {
    const res = await fetch(`${BASE}/contracts/${id}/abi`);
    if (!res.ok) throw new Error(`API ${res.status}: /contracts/${id}/abi`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}.abi.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};
