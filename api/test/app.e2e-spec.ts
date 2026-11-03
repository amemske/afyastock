import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

// Needs the database running with data from the Python jobs.
describe('AfyaStock API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  it('GET /api/health', () => request(app.getHttpServer()).get('/api/health').expect(200, { status: 'ok' }));

  it('GET /api/alerts returns a ranked list with counts', async () => {
    const res = await request(app.getHttpServer()).get('/api/alerts?limit=5').expect(200);
    expect(res.body.items.length).toBeLessThanOrEqual(5);
    expect(res.body.counts).toHaveProperty('out_now');
  });

  it('GET /api/alerts rejects an unknown status', () =>
    request(app.getHttpServer()).get('/api/alerts?status=urgent').expect(400));

  it('GET /api/transfers groups suggestions into trips', async () => {
    const res = await request(app.getHttpServer()).get('/api/transfers').expect(200);
    expect(Array.isArray(res.body.trips)).toBe(true);
  });

  it('GET /api/reorders flags orders against the chosen budget', async () => {
    const res = await request(app.getHttpServer()).get('/api/reorders?budget=50000').expect(200);
    if (res.body.summary) {
      expect(res.body.summary.budget_kes).toBe(50000);
      expect(res.body.summary.cost_funded_kes).toBeLessThanOrEqual(50000);
    }
  });

  it('GET /api/reorders rejects a non-numeric budget', () =>
    request(app.getHttpServer()).get('/api/reorders?budget=lots').expect(400));

  afterAll(async () => {
    await app.close();
  });
});
