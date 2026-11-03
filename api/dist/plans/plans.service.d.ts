import { DatabaseService } from '../database/database.service.js';
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
export declare class PlansService {
    private readonly db;
    constructor(db: DatabaseService);
    private run;
    transfers(locationId?: number): Promise<{
        run: null;
        summary: null;
        trips: never[];
    } | {
        run: {
            id: number;
        };
        summary: Record<string, number>;
        trips: {
            from_id: number;
            from_name: string;
            to_id: number;
            to_name: string;
            distance_km: number;
            most_urgent_days: number;
            value_kes: number;
            lines: TransferLine[];
        }[];
    }>;
    reorders(budget?: number, locationId?: number): Promise<{
        run: null;
        budget: number;
        summary: null;
        lines: never[];
    } | {
        run: {
            id: number;
        };
        summary: {
            budget_kes: number;
            lines_total: number;
            cost_total_kes: number;
            lines_funded: number;
            cost_funded_kes: number;
            vital_funded: number;
            vital_total: number;
            expected_stockouts_prevented: number;
            expected_stockouts_total: number;
            default_budget_kes: number;
        };
        lines: {
            within_budget: boolean;
            id: number;
            rank: number;
            location_id: number;
            location_name: string;
            item_id: number;
            item_name: string;
            unit: string;
            ven: string;
            quantity: number;
            cost: number;
            cumulative_cost: number;
            remaining_risk: number;
            urgency_days: number;
            alert_id: number | null;
        }[];
        budget?: undefined;
    }>;
}
