var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { DatabaseModule } from './database/database.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { ReferenceModule } from './reference/reference.module.js';
import { PlansModule } from './plans/plans.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
let AppModule = class AppModule {
};
AppModule = __decorate([
    Module({
        imports: [DatabaseModule, ReferenceModule, AlertsModule, PlansModule, AssistantModule],
        controllers: [AppController],
    })
], AppModule);
export { AppModule };
//# sourceMappingURL=app.module.js.map