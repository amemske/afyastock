import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database/database.service.js';

@Controller()
export class AppController {
  constructor(private readonly db: DatabaseService) {}

  /** Liveness check that also confirms the database is reachable. */
  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { status: 'ok' };
  }
}
