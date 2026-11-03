import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { DatabaseService } from './database/database.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: DatabaseService, useValue: { query: async () => [] } }],
    }).compile();
    appController = app.get<AppController>(AppController);
  });

  it('reports ok when the database answers', async () => {
    expect(await appController.health()).toEqual({ status: 'ok' });
  });
});
