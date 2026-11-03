/** How alerts are grouped for people: the database stores type + horizon. */
export const STATUSES = ['out_now', 'within_30', 'within_60', 'expiry'] as const;
export type AlertStatus = (typeof STATUSES)[number];

/** SQL expression mapping an alerts row (alias a) to a status. */
export const STATUS_SQL = `CASE
    WHEN a.alert_type = 'expiry_risk' THEN 'expiry'
    WHEN a.horizon_days = 0 THEN 'out_now'
    WHEN a.horizon_days <= 30 THEN 'within_30'
    ELSE 'within_60' END`;

/** Priority order: empty shelves first, then soonest and most likely stockouts, then expiry. */
export const STATUS_RANK_SQL = `CASE ${STATUS_SQL}
    WHEN 'out_now' THEN 0 WHEN 'within_30' THEN 1 WHEN 'within_60' THEN 2 ELSE 3 END`;

export function isStatus(v: unknown): v is AlertStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}
