import { DatabaseService } from '../database/database.service.js';
export declare class ReferenceController {
    private readonly db;
    constructor(db: DatabaseService);
    overview(): Promise<{
        region: {} | null;
        locations: {};
        items: {};
        latestRun: Record<string, unknown>;
        syntheticData: boolean;
    }>;
    locations(): Promise<Record<string, unknown>[]>;
    items(): Promise<Record<string, unknown>[]>;
}
