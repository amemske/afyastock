import { DatabaseService } from '../database/database.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { PlansService } from '../plans/plans.service.js';
import type { ToolSpec } from './llm.js';
export interface ToolResult {
    data: unknown;
    source: string;
}
export declare const TOOL_SPECS: ToolSpec[];
export declare class AssistantTools {
    private readonly db;
    private readonly alerts;
    private readonly plans;
    constructor(db: DatabaseService, alerts: AlertsService, plans: PlansService);
    run(name: string, args: Record<string, unknown>): Promise<ToolResult>;
    private findOne;
    private resolve;
    private overview;
    private getAlerts;
    private facilitySummary;
    private alertDetail;
    private transfers;
    private reorders;
    private lookupMedicine;
    private searchGuidance;
}
