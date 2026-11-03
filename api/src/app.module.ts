import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { DatabaseModule } from './database/database.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { ReferenceModule } from './reference/reference.module.js';

@Module({
  imports: [DatabaseModule, ReferenceModule, AlertsModule],
  controllers: [AppController],
})
export class AppModule {}
