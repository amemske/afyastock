export declare const STATUSES: readonly ["out_now", "within_30", "within_60", "expiry"];
export type AlertStatus = (typeof STATUSES)[number];
export declare const STATUS_SQL = "CASE\n    WHEN a.alert_type = 'expiry_risk' THEN 'expiry'\n    WHEN a.horizon_days = 0 THEN 'out_now'\n    WHEN a.horizon_days <= 30 THEN 'within_30'\n    ELSE 'within_60' END";
export declare const STATUS_RANK_SQL = "CASE CASE\n    WHEN a.alert_type = 'expiry_risk' THEN 'expiry'\n    WHEN a.horizon_days = 0 THEN 'out_now'\n    WHEN a.horizon_days <= 30 THEN 'within_30'\n    ELSE 'within_60' END\n    WHEN 'out_now' THEN 0 WHEN 'within_30' THEN 1 WHEN 'within_60' THEN 2 ELSE 3 END";
export declare function isStatus(v: unknown): v is AlertStatus;
