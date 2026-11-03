var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';
import { isStatus, STATUSES } from './alert-status.js';
function optionalId(v, name) {
    if (v === undefined || v === '')
        return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1)
        throw new BadRequestException(`${name} must be a positive whole number`);
    return n;
}
let AlertsController = class AlertsController {
    alerts;
    constructor(alerts) {
        this.alerts = alerts;
    }
    list(status, locationId, itemId, limit, offset) {
        if (status && !isStatus(status)) {
            throw new BadRequestException(`status must be one of: ${STATUSES.join(', ')}`);
        }
        return this.alerts.list({
            status: status ? status : undefined,
            locationId: optionalId(locationId, 'location_id'),
            itemId: optionalId(itemId, 'item_id'),
            limit: Math.min(optionalId(limit, 'limit') ?? 50, 200),
            offset: Math.max(Number(offset) || 0, 0),
        });
    }
    detail(id) {
        return this.alerts.detail(id);
    }
};
__decorate([
    Get(),
    __param(0, Query('status')),
    __param(1, Query('location_id')),
    __param(2, Query('item_id')),
    __param(3, Query('limit')),
    __param(4, Query('offset')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String]),
    __metadata("design:returntype", void 0)
], AlertsController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Param('id', ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], AlertsController.prototype, "detail", null);
AlertsController = __decorate([
    Controller('alerts'),
    __metadata("design:paramtypes", [AlertsService])
], AlertsController);
export { AlertsController };
//# sourceMappingURL=alerts.controller.js.map