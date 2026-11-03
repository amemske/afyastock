import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

const LATEST_OPTIMISE = `(SELECT max(id) FROM model_runs WHERE job = 'optimise')`;
const URGENCY_SQL = `COALESCE(al.horizon_days, 999)`;

export interface TransferLine {
  id: number;
  from_id: number;
  from_name: string;
  to_id: number;
  to_name: string;
  distance_km: number;
  item_id: number;
  item_name: string;
  unit: string;
  ven: string;
  quantity: number;
  value_kes: number;
  urgency_days: number;
  alert_id: number | null;
  reason: string;
}

@Injectable()
export class PlansService {
  constructor(private readonly db: DatabaseService) {}

  private async run() {
    const [run] = await this.db.query<{ id: number; metrics: Record<string, number>; params: Record<string, unknown> }>(
      `SELECT id, metrics, params FROM model_runs WHERE id = ${LATEST_OPTIMISE}`,
    );
    return run ?? null;
  }

  /** Transfer suggestions grouped into trips (one vehicle run between two facilities). */
  async transfers(locationId?: number) {
    const run = await this.run();
    if (!run) return { run: null, summary: null, trips: [] };
    const params: unknown[] = [];
    let filter = '';
    if (locationId) {
      params.push(locationId);
      filter = `AND (t.from_location_id = $1 OR t.to_location_id = $1)`;
    }
    const lines = await this.db.query<TransferLine>(
      `SELECT t.id::int AS id, f.id AS from_id, f.name AS from_name, r.id AS to_id, r.name AS to_name,
              t.distance_km::float8 AS distance_km, i.id AS item_id, i.name AS item_name, i.unit,
              COALESCE(i.attributes->>'ven', 'E') AS ven, t.quantity::int AS quantity,
              (t.quantity * i.unit_cost)::float8 AS value_kes, ${URGENCY_SQL} AS urgency_days,
              al.id::int AS alert_id, t.reason
         FROM transfer_suggestions t
         JOIN locations f ON f.id = t.from_location_id
         JOIN locations r ON r.id = t.to_location_id
         JOIN items i ON i.id = t.item_id
         LEFT JOIN alerts al ON al.location_id = t.to_location_id AND al.item_id = t.item_id
              AND al.alert_type = 'stockout_risk'
              AND al.run_id = (SELECT (params->>'forecast_run')::int FROM model_runs WHERE id = t.run_id)
        WHERE t.run_id = ${LATEST_OPTIMISE} ${filter}
        ORDER BY ${URGENCY_SQL}, t.quantity * i.unit_cost DESC`,
      params,
    );

    const trips = new Map<string, {
      from_id: number; from_name: string; to_id: number; to_name: string; distance_km: number;
      most_urgent_days: number; value_kes: number; lines: TransferLine[];
    }>();
    for (const l of lines) {
      const key = `${l.from_id}-${l.to_id}`;
      const trip = trips.get(key) ?? {
        from_id: l.from_id, from_name: l.from_name, to_id: l.to_id, to_name: l.to_name,
        distance_km: l.distance_km, most_urgent_days: l.urgency_days, value_kes: 0, lines: [],
      };
      trip.most_urgent_days = Math.min(trip.most_urgent_days, l.urgency_days);
      trip.value_kes += l.value_kes;
      trip.lines.push(l);
      trips.set(key, trip);
    }
    const sorted = [...trips.values()].sort(
      (a, b) => a.most_urgent_days - b.most_urgent_days || b.lines.length - a.lines.length || b.value_kes - a.value_kes,
    );
    return { run: { id: run.id }, summary: run.metrics, trips: sorted };
  }

  /** Reorders in priority order, flagged against a budget the pharmacist chooses. */
  async reorders(budget?: number, locationId?: number) {
    const run = await this.run();
    if (!run) return { run: null, budget: 0, summary: null, lines: [] };
    const ceiling = budget ?? Number(run.params?.default_budget_kes ?? 150000);

    const all = await this.db.query<{
      id: number; rank: number; location_id: number; location_name: string; item_id: number; item_name: string;
      unit: string; ven: string; quantity: number; cost: number; cumulative_cost: number; remaining_risk: number;
      urgency_days: number; alert_id: number | null;
    }>(
      `SELECT p.id::int AS id, p.priority_rank AS rank, l.id AS location_id, l.name AS location_name,
              i.id AS item_id, i.name AS item_name, i.unit, COALESCE(i.attributes->>'ven', 'E') AS ven,
              p.quantity::int AS quantity, p.cost::float8 AS cost,
              (sum(p.cost) OVER (ORDER BY p.priority_rank))::float8 AS cumulative_cost,
              p.stockouts_prevented::float8 AS remaining_risk, ${URGENCY_SQL} AS urgency_days, al.id::int AS alert_id
         FROM reorder_plans p
         JOIN locations l ON l.id = p.location_id
         JOIN items i ON i.id = p.item_id
         LEFT JOIN alerts al ON al.location_id = p.location_id AND al.item_id = p.item_id
              AND al.alert_type = 'stockout_risk'
              AND al.run_id = (SELECT (params->>'forecast_run')::int FROM model_runs WHERE id = p.run_id)
        WHERE p.run_id = ${LATEST_OPTIMISE}
        ORDER BY p.priority_rank`,
    );
    const withFlag = all.map((l) => ({ ...l, within_budget: l.cumulative_cost <= ceiling }));
    const funded = withFlag.filter((l) => l.within_budget);
    const summary = {
      budget_kes: ceiling,
      lines_total: all.length,
      cost_total_kes: all.reduce((s, l) => s + l.cost, 0),
      lines_funded: funded.length,
      cost_funded_kes: funded.reduce((s, l) => s + l.cost, 0),
      vital_funded: funded.filter((l) => l.ven === 'V').length,
      vital_total: all.filter((l) => l.ven === 'V').length,
      expected_stockouts_prevented: Math.round(funded.reduce((s, l) => s + l.remaining_risk, 0) * 10) / 10,
      expected_stockouts_total: Math.round(all.reduce((s, l) => s + l.remaining_risk, 0) * 10) / 10,
      default_budget_kes: Number(run.params?.default_budget_kes ?? 150000),
    };
    const lines = locationId ? withFlag.filter((l) => l.location_id === locationId) : withFlag;
    return { run: { id: run.id }, summary, lines };
  }
}
