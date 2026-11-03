import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';
import { AlertStatus, isStatus, STATUSES } from './alert-status.js';

function optionalId(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException(`${name} must be a positive whole number`);
  return n;
}

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('location_id') locationId?: string,
    @Query('item_id') itemId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (status && !isStatus(status)) {
      throw new BadRequestException(`status must be one of: ${STATUSES.join(', ')}`);
    }
    return this.alerts.list({
      status: status ? (status as AlertStatus) : undefined,
      locationId: optionalId(locationId, 'location_id'),
      itemId: optionalId(itemId, 'item_id'),
      limit: Math.min(optionalId(limit, 'limit') ?? 50, 200),
      offset: Math.max(Number(offset) || 0, 0),
    });
  }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.alerts.detail(id);
  }
}
