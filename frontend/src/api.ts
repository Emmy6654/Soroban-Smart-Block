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

export const api = {
  events: (params: { contract?: string; fn?: string; page?: number }) => {
    const q = new URLSearchParams();
    if (params.contract) q.set("contract", params.contract);
    if (params.fn)       q.set("fn", params.fn);
    if (params.page)     q.set("page", String(params.page));
    return get<DecodedEvent[]>(`/events?${q}`);
  },
  event:    (seq: number)     => get<DecodedEvent>(`/events/${seq}`),
  contract: (id: string)      => get<ContractMeta>(`/contracts/${id}`),
  wallet:   (address: string) => get<DecodedEvent[]>(`/wallet/${address}`),

  // Issue #38: contract transaction history with filters
  contractTransactions: (
    id: string,
    params: { function_name?: string; start_ledger?: number; end_ledger?: number; page?: number; limit?: number } = {}
  ) => {
    const q = new URLSearchParams();
    if (params.function_name) q.set("function_name", params.function_name);
    if (params.start_ledger)  q.set("start_ledger",  String(params.start_ledger));
    if (params.end_ledger)    q.set("end_ledger",     String(params.end_ledger));
    if (params.page)          q.set("page",           String(params.page));
    if (params.limit)         q.set("limit",          String(params.limit));
    return get<ContractTransactionsResponse>(`/v1/contracts/${id}/transactions?${q}`);
  },
};
