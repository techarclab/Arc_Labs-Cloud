import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth/auth.controller';
import { AccessService } from './common/access.service';
import { AuditService } from './common/audit.service';
import { JwtAuthGuard, Public } from './common/http';
import { loadConfig } from './config';
import { Db, DbModule } from './db/db.service';
import { DevicesController } from './devices/devices.controller';
import { DeviceHttpController } from './device-http/device-http.controller';
import { IngestService } from './common/ingest.service';
import { MqttPublisher } from './common/mqtt-publisher.service';
import { MqttHooksController } from './internal/mqtt-hooks.controller';
import { OrganizationsController } from './organizations/organizations.controller';
import { ProjectsController } from './projects/projects.controller';

@Controller('health')
class HealthController {
  constructor(private readonly db: Db) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.db.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'db_unavailable' });
    }
  }
}

/** Public management API (port 3000). */
@Module({
  imports: [
    DbModule,
    JwtModule.registerAsync({
      useFactory: () => ({ secret: loadConfig().JWT_SECRET, signOptions: { issuer: 'arc-cloud', audience: 'arc-cloud-api' }, verifyOptions: { issuer: 'arc-cloud', audience: 'arc-cloud-api' } }),
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
  ],
  controllers: [HealthController, AuthController, OrganizationsController, ProjectsController, DevicesController, DeviceHttpController],
  providers: [
    AccessService,
    AuditService,
    IngestService,
    MqttPublisher,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}

/** Broker-facing hooks (port 3001, private network only). */
@Module({
  imports: [DbModule],
  controllers: [MqttHooksController, HealthController],
})
export class InternalModule {}
