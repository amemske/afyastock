import { PlansService } from './plans.service.js';
export declare class PlansController {
    private readonly plans;
    constructor(plans: PlansService);
    transfers(locationId?: string): Promise<{
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
            lines: import("./plans.service.js").TransferLine[];
        }[];
    }>;
    reorders(budget?: string, locationId?: string): Promise<{
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
