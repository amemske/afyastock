import { AlertsService } from './alerts.service.js';
export declare class AlertsController {
    private readonly alerts;
    constructor(alerts: AlertsService);
    list(status?: string, locationId?: string, itemId?: string, limit?: string, offset?: string): Promise<{
        total: number;
        counts: {
            out_now: number;
            within_30: number;
            within_60: number;
            expiry: number;
        };
        items: {
            [x: string]: unknown;
        }[];
    }>;
    detail(id: number): Promise<{
        alert: Record<string, unknown> & {
            location_id: number;
            item_id: number;
            run_id: number;
        };
        history: Record<string, unknown>[];
        forecast: Record<string, unknown>[];
        issues: Record<string, unknown>[];
    }>;
}
