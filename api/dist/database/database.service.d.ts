import '../env.js';
import { OnModuleDestroy } from '@nestjs/common';
export declare class DatabaseService implements OnModuleDestroy {
    private readonly pool;
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
    onModuleDestroy(): Promise<void>;
}
