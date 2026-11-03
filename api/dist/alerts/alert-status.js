export const STATUSES = ['out_now', 'within_30', 'within_60', 'expiry'];
export const STATUS_SQL = `CASE
    WHEN a.alert_type = 'expiry_risk' THEN 'expiry'
    WHEN a.horizon_days = 0 THEN 'out_now'
    WHEN a.horizon_days <= 30 THEN 'within_30'
    ELSE 'within_60' END`;
export const STATUS_RANK_SQL = `CASE ${STATUS_SQL}
    WHEN 'out_now' THEN 0 WHEN 'within_30' THEN 1 WHEN 'within_60' THEN 2 ELSE 3 END`;
export function isStatus(v) {
    return typeof v === 'string' && STATUSES.includes(v);
}
//# sourceMappingURL=alert-status.js.map