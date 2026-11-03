import '../env.js';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

/** Thin wrapper over a pg connection pool. All SQL in the app is parameterised. */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgresql://afyastock@localhost:5432/afyastock',
    max: 10,
  });

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
