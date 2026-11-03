import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { DatabaseModule } from './database/database.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { ReferenceModule } from './reference/reference.module.js';
import { PlansModule } from './plans/plans.module.js';
import { AssistantModule } from './assistant/assistant.module.js';

@Module({
  imports: [DatabaseModule, ReferenceModule, AlertsModule, PlansModule, AssistantModule],
  controllers: [AppController],
})
export class AppModule {}
