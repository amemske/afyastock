import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

@Controller()
export class ReferenceController {
  constructor(private readonly db: DatabaseService) {}

  /** Region, data freshness and the latest forecast run, for the dashboard header. */
  @Get('overview')
  async overview() {
    const [run] = await this.db.query(
      `SELECT id, to_char(data_until, 'YYYY-MM-DD') AS data_until, created_at,
              metrics->'overall' AS backtest, metrics->'alerts_backtest' AS alerts_backtest
         FROM model_runs WHERE job = 'forecast' ORDER BY id DESC LIMIT 1`,
    );
    const [region] = await this.db.query(
      `SELECT region AS name, count(*)::int AS locations FROM locations WHERE active GROUP BY region
        ORDER BY count(*) DESC LIMIT 1`,
    );
    const [items] = await this.db.query(`SELECT count(*)::int AS n FROM items`);
    return {
      region: region?.name ?? null,
      locations: region?.locations ?? 0,
      items: items?.n ?? 0,
      latestRun: run ?? null,
      syntheticData: true,
    };
  }

  @Get('locations')
  locations() {
    return this.db.query(
      `SELECT id, code, name, location_type AS type, (attributes->>'rural')::boolean AS rural
         FROM locations WHERE active ORDER BY name`,
    );
  }

  @Get('items')
  items() {
    return this.db.query(`SELECT id, code, name, unit, category FROM items ORDER BY name`);
  }
}
