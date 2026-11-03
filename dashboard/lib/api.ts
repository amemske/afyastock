/** Typed access to the AfyaStock API. Runs on the server (Next.js server components). */

export const API_URL = process.env.API_URL ?? 'http://localhost:3001/api';

export type AlertStatus = 'out_now' | 'within_30' | 'within_60' | 'expiry';

export interface Overview {
  region: string | null;
  locations: number;
  items: number;
  latestRun: { id: number; data_until: string; created_at: string } | null;
  syntheticData: boolean;
}

export interface Place { id: number; code: string; name: string; type: string; rural: boolean }
export interface Medicine { id: number; code: string; name: string; unit: string; category: string }

export interface AlertRow {
  id: number;
  status: AlertStatus;
  risk: number;
  months_of_stock: number | null;
  confidence: 'high' | 'low';
  headline: string | null;
  location_id: number;
  location_name: string;
  location_type: string;
  item_id: number;
  item_code: string;
  item_name: string;
  unit: string;
  next_month_use: number | null;
}

export interface AlertList {
  total: number;
  counts: Record<AlertStatus, number>;
  items: AlertRow[];
}

export interface Driver { factor: string; text: string; effect?: number }

export interface AlertDetail {
  alert: AlertRow & {
    drivers: Driver[];
    location_code: string;
    rural: boolean;
    category: string;
    horizon_days: number;
  };
  history: {
    period: string; opening: number; received: number; used: number; losses: number;
    closing: number; expiring: number; imputed: boolean; empty_shelf: boolean;
  }[];
  forecast: { period: string; predicted: number; lower: number; upper: number }[];
  issues: { period: string; rule: string; severity: string; message: string; action_taken: string }[];
  actions?: {
    transfers: { from_name: string; quantity: number; distance_km: number; reason: string }[];
    reorder: { quantity: number; cost: number; rank: number; of_total: number } | null;
  };
}

export interface TransferLine {
  id: number; from_id: number; from_name: string; to_id: number; to_name: string; distance_km: number;
  item_id: number; item_name: string; unit: string; ven: string; quantity: number; value_kes: number;
  urgency_days: number; alert_id: number | null; reason: string;
}

export interface Trip {
  from_id: number; from_name: string; to_id: number; to_name: string; distance_km: number;
  most_urgent_days: number; value_kes: number; lines: TransferLine[];
}

export interface TransferPlan {
  run: { id: number } | null;
  summary: {
    transfers: number; trips: number; units_moved: number; value_moved_kes: number;
    expiring_units_saved: number; expiring_value_saved_kes: number;
    out_of_stock_lines: number; out_of_stock_lines_helped_by_transfer: number;
    reorder_cost_total_kes: number; reorder_cost_without_transfers_kes: number;
  } | null;
  trips: Trip[];
}

export interface ReorderLine {
  id: number; rank: number; location_id: number; location_name: string; item_id: number; item_name: string;
  unit: string; ven: string; quantity: number; cost: number; cumulative_cost: number; remaining_risk: number;
  urgency_days: number; alert_id: number | null; within_budget: boolean;
}

export interface ReorderPlan {
  run: { id: number } | null;
  summary: {
    budget_kes: number; lines_total: number; cost_total_kes: number; lines_funded: number; cost_funded_kes: number;
    vital_funded: number; vital_total: number; expected_stockouts_prevented: number; expected_stockouts_total: number;
    default_budget_kes: number;
  } | null;
  lines: ReorderLine[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  } catch {
    throw new ApiError(`Can't reach the AfyaStock API at ${API_URL}.`);
  }
  if (!res.ok) throw new ApiError(`The API answered ${res.status} for ${path}.`, res.status);
  return res.json() as Promise<T>;
}

export const api = {
  overview: () => get<Overview>('/overview'),
  locations: () => get<Place[]>('/locations'),
  items: () => get<Medicine[]>('/items'),
  alerts: (q: URLSearchParams) => get<AlertList>(`/alerts?${q.toString()}`),
  alert: (id: number) => get<AlertDetail>(`/alerts/${id}`),
  transfers: (q: URLSearchParams) => get<TransferPlan>(`/transfers?${q.toString()}`),
  reorders: (q: URLSearchParams) => get<ReorderPlan>(`/reorders?${q.toString()}`),
};
