import { DatabaseService } from '../database/database.service.js';
import { AlertStatus } from './alert-status.js';
export interface AlertFilters {
    status?: AlertStatus;
    locationId?: number;
    itemId?: number;
    limit: number;
    offset: number;
}
export declare class AlertsService {
    private readonly db;
    constructor(db: DatabaseService);
    list(f: AlertFilters): Promise<{
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
        actions: {
            transfers: Record<string, unknown>[];
            reorder: Record<string, unknown>;
        };
    }>;
}
