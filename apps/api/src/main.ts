import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApi } from './openapi';
import { AppModule, InternalModule } from './app.module';
import { loadConfig } from './config';
import { migrate } from './db/migrate';

async function bootstrap() {
  const cfg = loadConfig();
  const log = new Logger('Bootstrap');

  if (process.env.RUN_MIGRATIONS === 'true') {
    await migrate(cfg.DATABASE_URL, (m) => log.log(m));
  }

  const api = await NestFactory.create<NestExpressApplication>(AppModule);
  api.useBodyParser('json', { limit: '256kb' });
  api.enableShutdownHooks();
  const origins = cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length) api.enableCors({ origin: origins, credentials: false });
  api.getHttpAdapter().getInstance().disable('x-powered-by');

  // OpenAPI: interactive docs at /api/docs, machine-readable spec at /api/openapi.json.
  const spec = buildOpenApi(api);
  SwaggerModule.setup('api/docs', api, spec, { jsonDocumentUrl: 'api/openapi.json', customSiteTitle: 'ARC Cloud API' });
  await api.listen(cfg.PORT, '0.0.0.0');
  log.log(`API listening on :${cfg.PORT}`);

  const internal = await NestFactory.create<NestExpressApplication>(InternalModule, { logger: ['error', 'warn', 'log'] });
  internal.useBodyParser('json', { limit: '16kb' });
  internal.enableShutdownHooks();
  await internal.listen(cfg.INTERNAL_PORT, '0.0.0.0');
  log.log(`Broker hooks listening on :${cfg.INTERNAL_PORT} (keep this port private)`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
