import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { AssistantTools } from './../src/assistant/tools.js';

// Needs the database with data from the Python jobs, including the KEML loader.
// DeepSeek is replaced by a local mock that behaves like the real API: a tool call first, then an answer.
describe('Assistant (e2e)', () => {
  let app: INestApplication<App>;
  let tools: AssistantTools;
  let mock: Server;
  const seen: { messages: { role: string; content: string | null; reasoning_content?: string }[]; tools: unknown[] }[] = [];

  beforeAll(async () => {
    mock = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        seen.push(parsed);
        const hasToolResult = parsed.messages.some((m: { role: string }) => m.role === 'tool');
        const message = hasToolResult
          ? { role: 'assistant', content: 'Oxytocin injection can be stocked from level 2, dispensaries (KEML 2023, p. 73).' }
          : {
              role: 'assistant', content: '', reasoning_content: 'Need the KEML entry.',
              tool_calls: [{ id: 'call_1', type: 'function',
                             function: { name: 'lookup_essential_medicine', arguments: '{"name":"oxytocin"}' } }],
            };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      });
    });
    await new Promise<void>((r) => mock.listen(0, r));
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    process.env.DEEPSEEK_API_KEY = 'test-key';

    const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    tools = app.get(AssistantTools);
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => mock.close(r));
  });

  it('runs the tool loop and returns the answer with its sources', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/assistant/ask')
      .send({ messages: [{ role: 'user', content: 'Can a dispensary stock oxytocin?' }] })
      .expect(200);
    expect(res.body.answer).toContain('level 2');
    expect(res.body.tools_used[0].name).toBe('lookup_essential_medicine');
    expect(res.body.sources[0]).toMatch(/Kenya Essential Medicines List 2023, p\. \d+/);
    // second request carried the tool result and the model's reasoning back
    const second = seen[seen.length - 1];
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('Oxytocin');
    expect(second.messages.some((m) => m.reasoning_content === 'Need the KEML entry.')).toBe(true);
    expect(seen[0].messages[0].role).toBe('system');
  });

  it('rejects an empty conversation', () =>
    request(app.getHttpServer()).post('/api/assistant/ask').send({ messages: [] }).expect(400));

  it('tool: overview', async () => {
    const r = await tools.run('get_overview', {});
    expect(r.data).toHaveProperty('facilities');
  });

  it('tool: alerts filtered by a misspelt medicine name', async () => {
    const r = (await tools.run('get_alerts', { medicine: 'amoxicilin', limit: 3 })).data as { alerts: { medicine: string }[] };
    expect(r.alerts.length).toBeGreaterThan(0);
    expect(r.alerts.every((a) => a.medicine.startsWith('Amoxicillin'))).toBe(true);
  });

  it('tool: unknown facility is reported, not guessed', async () => {
    const r = (await tools.run('get_alerts', { facility: 'Kenyatta National Hospital' })).data as { error?: string };
    expect(r.error).toMatch(/No facility/);
  });

  it('tool: alert detail, transfers and reorders', async () => {
    const list = (await tools.run('get_alerts', { status: 'out_now', limit: 1 })).data as {
      alerts: { facility: string; medicine: string }[];
    };
    const a = list.alerts[0];
    const d = (await tools.run('get_alert_detail', { facility: a.facility, medicine: a.medicine })).data as { reasons: string[] };
    expect(d.reasons.length).toBeGreaterThan(0);
    const t = (await tools.run('get_transfers', {})).data as { trips: unknown[] };
    expect(Array.isArray(t.trips)).toBe(true);
    const o = (await tools.run('get_reorders', { budget_kes: 50000 })).data as { summary: { budget_kes: number } };
    expect(o.summary.budget_kes).toBe(50000);
  });

  it('tool: KEML lookup includes level of use and exceptions in notes', async () => {
    const r = (await tools.run('lookup_essential_medicine', { name: 'ceftriaxone' })).data as {
      entries: { level_of_use: number; notes: string | null }[];
    };
    expect(r.entries.every((e) => e.level_of_use === 4)).toBe(true);
    expect(r.entries.some((e) => (e.notes ?? '').includes('At Level 2'))).toBe(true);
    const none = (await tools.run('lookup_essential_medicine', { name: 'Augmentin' })).data as { result?: string };
    expect(none.result).toMatch(/generic name/);
  });

  it('tool: facility summary covers every facility with alerts', async () => {
    const r = (await tools.run('get_facility_summary', { limit: 40 })).data as {
      facilities: { out_of_stock_now: number; total_alerts: number }[]; facilities_with_alerts: number;
    };
    expect(r.facilities.length).toBe(r.facilities_with_alerts);
    expect(r.facilities[0].out_of_stock_now).toBeGreaterThanOrEqual(r.facilities[1].out_of_stock_now);
  });

  it('tool: guidance search', async () => {
    const r = (await tools.run('search_guidance', { query: 'Watch group antibiotics' })).data as { passages: unknown[] };
    expect(r.passages.length).toBeGreaterThan(0);
  });
});
