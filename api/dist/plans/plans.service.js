var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
const LATEST_OPTIMISE = `(SELECT max(id) FROM model_runs WHERE job = 'optimise')`;
const URGENCY_SQL = `COALESCE(al.horizon_days, 999)`;
let PlansService = class PlansService {
    db;
    constructor(db) {
        this.db = db;
    }
    async run() {
        const [run] = await this.db.query(`SELECT id, metrics, params FROM model_runs WHERE id = ${LATEST_OPTIMISE}`);
        return run ?? null;
    }
    async transfers(locationId) {
        const run = await this.run();
        if (!run)
            return { run: null, summary: null, trips: [] };
        const params = [];
        let filter = '';
        if (locationId) {
            params.push(locationId);
            filter = `AND (t.from_location_id = $1 OR t.to_location_id = $1)`;
        }
        const lines = await this.db.query(`SELECT t.id::int AS id, f.id AS from_id, f.name AS from_name, r.id AS to_id, r.name AS to_name,
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
        ORDER BY ${URGENCY_SQL}, t.quantity * i.unit_cost DESC`, params);
        const trips = new Map();
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
        const sorted = [...trips.values()].sort((a, b) => a.most_urgent_days - b.most_urgent_days || b.lines.length - a.lines.length || b.value_kes - a.value_kes);
        return { run: { id: run.id }, summary: run.metrics, trips: sorted };
    }
    async reorders(budget, locationId) {
        const run = await this.run();
        if (!run)
            return { run: null, budget: 0, summary: null, lines: [] };
        const ceiling = budget ?? Number(run.params?.default_budget_kes ?? 150000);
        const all = await this.db.query(`SELECT p.id::int AS id, p.priority_rank AS rank, l.id AS location_id, l.name AS location_name,
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
        ORDER BY p.priority_rank`);
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
};
PlansService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DatabaseService])
], PlansService);
export { PlansService };
//# sourceMappingURL=plans.service.js.map