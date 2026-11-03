import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PlansService } from './plans.service.js';

function optionalPositive(v: string | undefined, name: string, integer = true): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
    throw new BadRequestException(`${name} must be a positive ${integer ? 'whole ' : ''}number`);
  }
  return n;
}

@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get('transfers')
  transfers(@Query('location_id') locationId?: string) {
    return this.plans.transfers(optionalPositive(locationId, 'location_id'));
  }

  @Get('reorders')
  reorders(@Query('budget') budget?: string, @Query('location_id') locationId?: string) {
    return this.plans.reorders(optionalPositive(budget, 'budget', false), optionalPositive(locationId, 'location_id'));
  }
}
