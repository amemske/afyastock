import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { AssistantTools } from './tools.js';

@Module({
  imports: [AlertsModule, PlansModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantTools],
  exports: [AssistantTools],
})
export class AssistantModule {}
