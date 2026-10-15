import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const spec = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('ARC Cloud API')
      .setVersion('1.0')
      .setDescription(
        'Multi-tenant IoT platform API. Authenticate with `Authorization: Bearer <token>`: a user token from /api/v1/auth/login or /api/v1/auth/google, ' +
          'an organization API key (arc_sk_…), or a service-account token from /api/v1/oauth/token. ' +
          'Device endpoints (/update, /controls, /commands/next) use the device key in `api_key`. Errors are JSON with a stable `code`. ' +
          'Lists take `limit` (max 200) and `offset`.',
      )
      .addBearerAuth()
      .build(),
  );
  spec.security = [{ bearer: [] }];
  return spec;
}

/** `node dist/openapi.js out.json` writes the spec without starting servers or touching the database. */
if (require.main === module) {
  void (async () => {
    process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';
    process.env.JWT_SECRET ??= 'x'.repeat(40);
    process.env.INTERNAL_HOOK_TOKEN ??= 'x'.repeat(30);
    process.env.MQTT_SERVICE_PASSWORD ??= 'x'.repeat(20);
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('./app.module');
    const { writeFileSync } = await import('node:fs');
    const app = await NestFactory.create(AppModule, { logger: false });
    const spec = buildOpenApi(app);
    writeFileSync(process.argv[2] ?? 'openapi.json', JSON.stringify(spec, null, 2) + '\n');
    console.log(`OpenAPI: ${Object.keys(spec.paths).length} paths written to ${process.argv[2] ?? 'openapi.json'}`);
    await app.close();
    process.exit(0);
  })();
}
