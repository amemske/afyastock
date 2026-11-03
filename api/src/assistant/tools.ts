import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { PlansService } from '../plans/plans.service.js';
import { isStatus } from '../alerts/alert-status.js';
import type { ToolSpec } from './llm.js';

/** What a tool returns: data for the model, plus a short label shown to the user as a source. */
export interface ToolResult {
  data: unknown;
  source: string;
}

const LEVELS: Record<number, string> = {
  1: 'community health services', 2: 'dispensary/clinic', 3: 'health centre',
  4: 'primary hospital', 5: 'secondary hospital', 6: 'tertiary hospital',
};
const STATUS_LABEL: Record<string, string> = {
  out_now: 'out of stock now', within_30: 'likely to run out within 30 days',
  within_60: 'likely to run out within 60 days', expiry: 'stock likely to expire unused',
};

const str = { type: 'string' };
export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_overview',
      description: 'Sub-county name, number of facilities and medicines, month of the latest reports, alert counts by type, and how accurate the forecasts were in testing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_alerts',
      description: 'Current stock alerts, most urgent first. Filter by facility name, medicine name and/or status. Use for "what needs attention", "which facilities are out of X", "what is at risk at Y".',
      parameters: {
        type: 'object',
        properties: {
          facility: { ...str, description: 'Facility name or part of it' },
          medicine: { ...str, description: 'Generic medicine name or part of it' },
          status: { type: 'string', enum: ['out_now', 'within_30', 'within_60', 'expiry'] },
          limit: { type: 'integer', description: 'Maximum alerts to return (default 10, max 25)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_facility_summary',
      description: 'Every facility ranked by its current alerts: counts out of stock now, at risk within 30 and 60 days, expiry risks, and how many are vital medicines. Use for "which facility needs most attention", comparisons between facilities, or a district overview by facility.',
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many facilities (default 10, max 40)' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_alert_detail',
      description: 'Everything about one medicine at one facility: why it is flagged, stock on hand, recent use, forecast, data problems, and suggested transfer or order. Use for "why is X flagged at Y".',
      parameters: {
        type: 'object',
        properties: { facility: str, medicine: str },
        required: ['facility', 'medicine'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transfers',
      description: 'Suggested stock transfers between facilities, grouped into trips. Filter by a facility (sending or receiving) and/or medicine.',
      parameters: { type: 'object', properties: { facility: str, medicine: str } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reorders',
      description: 'The reorder plan ranked by priority, and what a given budget in Kenya shillings covers (orders, vital medicines, expected stockouts prevented).',
      parameters: {
        type: 'object',
        properties: { budget_kes: { type: 'number' }, facility: str },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_essential_medicine',
      description: 'Kenya Essential Medicines List 2023 entries for a GENERIC medicine name: forms, strengths, level of use (lowest level of care allowed to stock it), restrictions in footnotes, section and page. Convert brand names to generic names first.',
      parameters: { type: 'object', properties: { name: str }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_guidance',
      description: 'Full-text search of the Kenya Essential Medicines List 2023 passages, for questions by condition, medicine class or topic (e.g. "antibiotics for pneumonia", "level of use definition", "Watch group antibiotics").',
      parameters: { type: 'object', properties: { query: str }, required: ['query'] },
    },
  },
];

@Injectable()
export class AssistantTools {
  constructor(
    private readonly db: DatabaseService,
    private readonly alerts: AlertsService,
    private readonly plans: PlansService,
  ) {}

  async run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'get_overview': return this.overview();
      case 'get_alerts': return this.getAlerts(args);
      case 'get_facility_summary': return this.facilitySummary(args);
      case 'get_alert_detail': return this.alertDetail(args);
      case 'get_transfers': return this.transfers(args);
      case 'get_reorders': return this.reorders(args);
      case 'lookup_essential_medicine': return this.lookupMedicine(String(args.name ?? ''));
      case 'search_guidance': return this.searchGuidance(String(args.query ?? ''));
      default: return { data: { error: `Unknown tool ${name}` }, source: name };
    }
  }

  // ---------- name resolution (forgiving: partial names and small misspellings) ----------

  private async findOne(table: 'locations' | 'items', name: string) {
    const q = name.trim();
    if (!q) return { match: null, candidates: [] as string[] };
    let rows: { id: number; name: string }[];
    try {
      rows = await this.db.query(
        `SELECT id, name FROM ${table}
          WHERE name ILIKE '%' || $1 || '%' OR ${table === 'items' ? `code ILIKE $1 OR ` : ''}word_similarity($1, name) > 0.5
          ORDER BY (name ILIKE $1 || '%') DESC, word_similarity($1, name) DESC, similarity(name, $1) DESC LIMIT 5`,
        [q],
      );
    } catch {
      rows = await this.db.query(`SELECT id, name FROM ${table} WHERE name ILIKE '%' || $1 || '%' LIMIT 5`, [q]);
    }
    return { match: rows[0] ?? null, candidates: rows.map((r) => r.name) };
  }

  private async resolve(args: Record<string, unknown>) {
    const notes: string[] = [];
    let locationId: number | undefined;
    let itemId: number | undefined;
    if (args.facility) {
      const f = await this.findOne('locations', String(args.facility));
      if (!f.match) return { error: `No facility in this sub-county matches "${args.facility}".` };
      locationId = f.match.id;
      if (f.candidates.length > 1) notes.push(`Facility matched "${f.match.name}"; other close names: ${f.candidates.slice(1).join(', ')}`);
    }
    if (args.medicine) {
      const m = await this.findOne('items', String(args.medicine));
      if (!m.match) return { error: `"${args.medicine}" is not one of the medicines tracked in this sub-county.` };
      itemId = m.match.id;
    }
    return { locationId, itemId, notes };
  }

  // ---------- tools ----------

  private async overview(): Promise<ToolResult> {
    const [o] = await this.db.query<Record<string, unknown>>(
      `SELECT (SELECT region FROM locations GROUP BY region ORDER BY count(*) DESC LIMIT 1) AS region,
              (SELECT count(*)::int FROM locations WHERE active) AS facilities,
              (SELECT count(*)::int FROM items) AS medicines,
              to_char(r.data_until, 'Mon YYYY') AS reports_up_to,
              r.metrics->'overall' AS forecast_backtest_error,
              r.metrics->'alerts_backtest'->'average_precision' AS alert_average_precision
         FROM model_runs r WHERE r.job = 'forecast' ORDER BY r.id DESC LIMIT 1`,
    );
    const counts = (await this.alerts.list({ limit: 1, offset: 0 })).counts;
    return {
      data: { ...o, alert_counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [STATUS_LABEL[k], v])),
              note: 'Demonstration data from a fictional sub-county. Forecast error is WAPE versus true demand in a backtest.' },
      source: 'Overview of the latest forecast run',
    };
  }

  private async getAlerts(args: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.resolve(args);
    if ('error' in r) return { data: { error: r.error }, source: 'Alert search' };
    const status = isStatus(args.status) ? args.status : undefined;
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
    const list = await this.alerts.list({ status, locationId: r.locationId, itemId: r.itemId, limit, offset: 0 });
    return {
      data: {
        total_matching: list.total,
        counts: Object.fromEntries(Object.entries(list.counts).map(([k, v]) => [STATUS_LABEL[k], v])),
        alerts: list.items.map((a) => ({
          alert_id: a.id, facility: a.location_name, medicine: a.item_name, status: STATUS_LABEL[a.status as string],
          chance_of_running_out: a.status === 'out_now' ? 'already out' : `${Math.round((a.risk as number) * 100)}%`,
          main_reason: a.headline, data_confidence: a.confidence,
        })),
        notes: r.notes,
        showing: `${list.items.length} of ${list.total}`,
      },
      source: `Stock alerts${args.facility ? ` at ${String(args.facility)}` : ''}${args.medicine ? ` for ${String(args.medicine)}` : ''}`,
    };
  }

  private async facilitySummary(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 40);
    const rows = await this.db.query(
      `SELECT l.name AS facility, l.location_type AS type,
              count(*) FILTER (WHERE a.alert_type = 'stockout_risk' AND a.horizon_days = 0)::int AS out_of_stock_now,
              count(*) FILTER (WHERE a.alert_type = 'stockout_risk' AND a.horizon_days = 30)::int AS within_30_days,
              count(*) FILTER (WHERE a.alert_type = 'stockout_risk' AND a.horizon_days = 60)::int AS within_60_days,
              count(*) FILTER (WHERE a.alert_type = 'expiry_risk')::int AS expiry_risks,
              count(*) FILTER (WHERE a.alert_type = 'stockout_risk' AND a.horizon_days = 0
                               AND COALESCE(i.attributes->>'ven', 'E') = 'V')::int AS vital_out_of_stock,
              count(*)::int AS total_alerts
         FROM alerts a
         JOIN locations l ON l.id = a.location_id
         JOIN items i ON i.id = a.item_id
        WHERE a.run_id = (SELECT max(id) FROM model_runs WHERE job = 'forecast')
        GROUP BY l.name, l.location_type
        ORDER BY out_of_stock_now DESC, vital_out_of_stock DESC, within_30_days DESC, total_alerts DESC
        LIMIT $1`,
      [limit],
    );
    const [all] = await this.db.query<{ n: number }>(
      `SELECT count(DISTINCT location_id)::int AS n FROM alerts
        WHERE run_id = (SELECT max(id) FROM model_runs WHERE job = 'forecast')`,
    );
    return {
      data: { facilities: rows, facilities_with_alerts: all?.n ?? 0,
              ranking: 'Ordered by medicines out of stock now, then vital medicines out, then 30-day risks, then total alerts. This covers every facility.' },
      source: 'Alert counts by facility (latest forecast)',
    };
  }

  private async alertDetail(args: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.resolve(args);
    if ('error' in r) return { data: { error: r.error }, source: 'Alert detail' };
    const [row] = await this.db.query<{ id: number }>(
      `SELECT a.id::int AS id FROM alerts a
        WHERE a.run_id = (SELECT max(id) FROM model_runs WHERE job = 'forecast')
          AND a.location_id = $1 AND a.item_id = $2
        ORDER BY (a.alert_type = 'stockout_risk') DESC LIMIT 1`,
      [r.locationId, r.itemId],
    );
    if (!row) {
      return { data: { result: 'No alert: this medicine is not flagged at this facility in the latest forecast.' }, source: 'Alert detail' };
    }
    const d = await this.alerts.detail(row.id);
    const a = d.alert as Record<string, unknown>;
    return {
      data: {
        alert_id: row.id,
        facility: a.location_name, medicine: a.item_name, unit: a.unit,
        status: STATUS_LABEL[a.status as string],
        chance_of_running_out: a.status === 'out_now' ? 'already out' : `${Math.round((a.risk as number) * 100)}%`,
        reasons: (a.drivers as { text: string }[]).map((x) => x.text),
        data_confidence: a.confidence,
        last_six_months: (d.history as Record<string, unknown>[]).slice(-6).map((h) => ({
          month: h.period, used: h.used, on_shelf_at_month_end: h.closing, estimated: h.imputed,
        })),
        forecast: d.forecast,
        data_problems: (d.issues as Record<string, unknown>[]).slice(0, 5),
        suggested_actions: d.actions,
      },
      source: `Alert detail: ${String(a.item_name)} at ${String(a.location_name)}`,
    };
  }

  private async transfers(args: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.resolve(args);
    if ('error' in r) return { data: { error: r.error }, source: 'Transfer plan' };
    const plan = await this.plans.transfers(r.locationId);
    const trips = plan.trips
      .map((t) => ({ ...t, lines: r.itemId ? t.lines.filter((l) => l.item_id === r.itemId) : t.lines }))
      .filter((t) => t.lines.length)
      .slice(0, 8)
      .map((t) => ({
        from: t.from_name, to: t.to_name, road_km: Math.round(t.distance_km),
        medicines: t.lines.map((l) => ({ medicine: l.item_name, quantity: `${l.quantity} ${l.unit}s`, reason: l.reason })),
      }));
    return {
      data: { summary: plan.summary, trips, showing: `${trips.length} trips` },
      source: `Transfer plan${args.facility ? ` for ${String(args.facility)}` : ''}`,
    };
  }

  private async reorders(args: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.resolve({ facility: args.facility });
    if ('error' in r) return { data: { error: r.error }, source: 'Reorder plan' };
    const budget = Number(args.budget_kes) > 0 ? Number(args.budget_kes) : undefined;
    const plan = await this.plans.reorders(budget, r.locationId);
    return {
      data: {
        summary: plan.summary,
        top_orders: plan.lines.slice(0, 10).map((l) => ({
          rank: l.rank, facility: l.location_name, medicine: l.item_name, ven: l.ven,
          quantity: `${l.quantity} ${l.unit}s`, cost_kes: l.cost, within_budget: l.within_budget,
        })),
      },
      source: `Reorder plan${budget ? ` at KES ${budget.toLocaleString('en-KE')}` : ''}`,
    };
  }

  private async lookupMedicine(name: string): Promise<ToolResult> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT name, dose_form, strength, level_of_use, notes, section, page
         FROM essential_medicines
        WHERE name ILIKE '%' || $1 || '%' OR word_similarity($1, name) > 0.5
        ORDER BY (name ILIKE $1) DESC, (name ILIKE $1 || '%') DESC, word_similarity($1, name) DESC, level_of_use
        LIMIT 15`,
      [name.trim()],
    ).catch(() => []);
    if (!rows.length) {
      return {
        data: { result: `No Kenya Essential Medicines List 2023 entry matches "${name}". If this is a brand name, try the generic name.` },
        source: 'Kenya Essential Medicines List 2023',
      };
    }
    const pages = [...new Set(rows.map((r) => r.page))].join(', ');
    return {
      data: {
        entries: rows.map((r) => ({
          ...r,
          level_of_use_meaning: r.level_of_use ? LEVELS[r.level_of_use as number] : 'not stated in the list',
        })),
        how_to_read: 'Level of use is the LOWEST level of care expected to stock the medicine; higher levels may also stock it. Footnotes in "notes" can restrict or extend this.',
      },
      source: `Kenya Essential Medicines List 2023, p. ${pages}`,
    };
  }

  private async searchGuidance(query: string): Promise<ToolResult> {
    const rows = await this.db.query<{ title: string; content: string; page: number | null }>(
      `SELECT title, content, page FROM guidance_chunks
        WHERE search @@ websearch_to_tsquery('english', $1)
        ORDER BY ts_rank(search, websearch_to_tsquery('english', $1)) DESC LIMIT 4`,
      [query],
    ).catch(() => []);
    return {
      data: rows.length
        ? { passages: rows.map((r) => ({ title: r.title, page: r.page, text: r.content.slice(0, 1400) })) }
        : { result: `No passage in the Kenya Essential Medicines List 2023 matches "${query}".` },
      source: `Kenya Essential Medicines List 2023${rows.length ? `, p. ${[...new Set(rows.map((r) => r.page).filter(Boolean))].join(', ')}` : ''}`,
    };
  }
}
