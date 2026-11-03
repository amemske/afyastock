var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import '../env.js';
import { Injectable } from '@nestjs/common';
import pg from 'pg';
let DatabaseService = class DatabaseService {
    pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL ?? 'postgresql://afyastock@localhost:5432/afyastock',
        max: 10,
    });
    async query(sql, params = []) {
        const result = await this.pool.query(sql, params);
        return result.rows;
    }
    async onModuleDestroy() {
        await this.pool.end();
    }
};
DatabaseService = __decorate([
    Injectable()
], DatabaseService);
export { DatabaseService };
//# sourceMappingURL=database.service.js.map