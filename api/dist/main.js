import './env.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    app.setGlobalPrefix('api');
    app.enableCors({ origin: process.env.DASHBOARD_ORIGIN ?? 'http://localhost:3000' });
    const port = Number(process.env.API_PORT ?? 3001);
    await app.listen(port);
    console.log(`AfyaStock API on http://localhost:${port}/api`);
}
await bootstrap();
//# sourceMappingURL=main.js.map