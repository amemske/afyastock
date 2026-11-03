var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { STATUS_RANK_SQL, STATUS_SQL } from './alert-status.js';
const LATEST_RUN = `(SELECT max(id) FROM model_runs WHERE job = 'forecast')`;
let AlertsService = class AlertsService {
    db;
    constructor(db) {
        this.db = db;
    }
    async list(f) {
        const where = [`a.run_id = ${LATEST_RUN}`];
        const params = [];
        if (f.locationId) {
            params.push(f.locationId);
            where.push(`a.location_id = $${params.length}`);
        }
        if (f.itemId) {
            params.push(f.itemId);
            where.push(`a.item_id = $${params.length}`);
        }
        const base = where.join(' AND ');
        const counts = await this.db.query(`SELECT ${STATUS_SQL} AS status, count(*)::int AS n FROM alerts a WHERE ${base} GROUP BY 1`, params);
        const listParams = [...params];
        let listWhere = base;
        if (f.status) {
            listParams.push(f.status);
            listWhere += ` AND ${STATUS_SQL} = $${listParams.length}`;
        }
        listParams.push(f.limit, f.offset);
        const rows = await this.db.query(`SELECT a.id::int AS id, ${STATUS_SQL} AS status, a.risk_score::float8 AS risk,
              a.months_of_stock::float8 AS months_of_stock, a.confidence,
              CASE WHEN a.horizon_days = 0 THEN coalesce(a.drivers->1->>'text', a.drivers->0->>'text')
                   ELSE a.drivers->0->>'text' END AS headline,
              l.id AS location_id, l.name AS location_name, l.location_type,
              i.id AS item_id, i.code AS item_code, i.name AS item_name, i.unit,
              fc.predicted_use::float8 AS next_month_use,
              count(*) OVER ()::int AS total
         FROM alerts a
         JOIN locations l ON l.id = a.location_id
         JOIN items i ON i.id = a.item_id
         LEFT JOIN LATERAL (
           SELECT predicted_use FROM forecasts f
            WHERE f.run_id = a.run_id AND f.location_id = a.location_id AND f.item_id = a.item_id
            ORDER BY f.period LIMIT 1) fc ON true
        WHERE ${listWhere}
        ORDER BY ${STATUS_RANK_SQL}, a.risk_score DESC, a.months_of_stock ASC NULLS FIRST, l.name, i.name
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`, listParams);
        const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
        return {
            total: rows[0]?.total ?? 0,
            counts: {
                out_now: byStatus.out_now ?? 0,
                within_30: byStatus.within_30 ?? 0,
                within_60: byStatus.within_60 ?? 0,
                expiry: byStatus.expiry ?? 0,
            },
            items: rows.map(({ total: _total, ...r }) => r),
        };
    }
    async detail(id) {
        const [alert] = await this.db.query(`SELECT a.id::int AS id, a.run_id, ${STATUS_SQL} AS status, a.risk_score::float8 AS risk,
              a.months_of_stock::float8 AS months_of_stock, a.confidence, a.drivers,
              a.horizon_days, a.created_at,
              l.id AS location_id, l.code AS location_code, l.name AS location_name, l.location_type,
              (l.attributes->>'rural')::boolean AS rural,
              i.id AS item_id, i.code AS item_code, i.name AS item_name, i.unit, i.category
         FROM alerts a
         JOIN locations l ON l.id = a.location_id
         JOIN items i ON i.id = a.item_id
        WHERE a.id = $1`, [id]);
        if (!alert)
            throw new NotFoundException(`No alert with id ${id}`);
        const [history, forecast, issues] = await Promise.all([
            this.db.query(`SELECT to_char(period, 'YYYY-MM-DD') AS period,
                opening_balance::float8 AS opening, quantity_received::float8 AS received,
                quantity_used::float8 AS used, losses::float8 AS losses,
                closing_balance::float8 AS closing, expiring_soon::float8 AS expiring,
                is_imputed AS imputed, (closing_balance <= 0) AS empty_shelf
           FROM stock_reports WHERE location_id = $1 AND item_id = $2 ORDER BY period`, [alert.location_id, alert.item_id]),
            this.db.query(`SELECT to_char(period, 'YYYY-MM-DD') AS period, predicted_use::float8 AS predicted,
                lower_bound::float8 AS lower, upper_bound::float8 AS upper
           FROM forecasts WHERE run_id = $1 AND location_id = $2 AND item_id = $3 ORDER BY period`, [alert.run_id, alert.location_id, alert.item_id]),
            this.db.query(`SELECT to_char(period, 'YYYY-MM-DD') AS period, rule, severity, message, action_taken
           FROM data_issues WHERE location_code = $1 AND item_code = $2 ORDER BY period DESC`, [alert.location_code, alert.item_code]),
        ]);
        return { alert, history, forecast, issues };
    }
};
AlertsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DatabaseService])
], AlertsService);
export { AlertsService };
//# sourceMappingURL=alerts.service.js.map