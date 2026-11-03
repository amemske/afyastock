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
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PlansService } from './plans.service.js';
function optionalPositive(v, name, integer = true) {
    if (v === undefined || v === '')
        return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
        throw new BadRequestException(`${name} must be a positive ${integer ? 'whole ' : ''}number`);
    }
    return n;
}
let PlansController = class PlansController {
    plans;
    constructor(plans) {
        this.plans = plans;
    }
    transfers(locationId) {
        return this.plans.transfers(optionalPositive(locationId, 'location_id'));
    }
    reorders(budget, locationId) {
        return this.plans.reorders(optionalPositive(budget, 'budget', false), optionalPositive(locationId, 'location_id'));
    }
};
__decorate([
    Get('transfers'),
    __param(0, Query('location_id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PlansController.prototype, "transfers", null);
__decorate([
    Get('reorders'),
    __param(0, Query('budget')),
    __param(1, Query('location_id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], PlansController.prototype, "reorders", null);
PlansController = __decorate([
    Controller(),
    __metadata("design:paramtypes", [PlansService])
], PlansController);
export { PlansController };
//# sourceMappingURL=plans.controller.js.map