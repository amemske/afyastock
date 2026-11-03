var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
let ReferenceController = class ReferenceController {
    db;
    constructor(db) {
        this.db = db;
    }
    async overview() {
        const [run] = await this.db.query(`SELECT id, to_char(data_until, 'YYYY-MM-DD') AS data_until, created_at,
              metrics->'overall' AS backtest, metrics->'alerts_backtest' AS alerts_backtest
         FROM model_runs WHERE job = 'forecast' ORDER BY id DESC LIMIT 1`);
        const [region] = await this.db.query(`SELECT region AS name, count(*)::int AS locations FROM locations WHERE active GROUP BY region
        ORDER BY count(*) DESC LIMIT 1`);
        const [items] = await this.db.query(`SELECT count(*)::int AS n FROM items`);
        return {
            region: region?.name ?? null,
            locations: region?.locations ?? 0,
            items: items?.n ?? 0,
            latestRun: run ?? null,
            syntheticData: true,
        };
    }
    locations() {
        return this.db.query(`SELECT id, code, name, location_type AS type, (attributes->>'rural')::boolean AS rural
         FROM locations WHERE active ORDER BY name`);
    }
    items() {
        return this.db.query(`SELECT id, code, name, unit, category FROM items ORDER BY name`);
    }
};
__decorate([
    Get('overview'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ReferenceController.prototype, "overview", null);
__decorate([
    Get('locations'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ReferenceController.prototype, "locations", null);
__decorate([
    Get('items'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], ReferenceController.prototype, "items", null);
ReferenceController = __decorate([
    Controller(),
    __metadata("design:paramtypes", [DatabaseService])
], ReferenceController);
export { ReferenceController };
//# sourceMappingURL=reference.controller.js.map