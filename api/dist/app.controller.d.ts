import { DatabaseService } from './database/database.service.js';
export declare class AppController {
    private readonly db;
    constructor(db: DatabaseService);
    health(): Promise<{
        status: string;
    }>;
}
