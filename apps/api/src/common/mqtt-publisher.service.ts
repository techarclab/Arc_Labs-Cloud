import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { buildTopic, commandMessage, controlMessage } from '@arc/shared';
import mqtt, { MqttClient } from 'mqtt';
import { loadConfig } from '../config';

/**
 * Publishes control values to devices on arc/v1/{org}/{project}/{device}/cmd.
 * Optional: if MQTT_URL is not set, controls are still stored and HTTP devices can poll them.
 */
@Injectable()
export class MqttPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MqttPublisher');
  private client: MqttClient | null = null;

  onModuleInit() {
    const cfg = loadConfig();
    if (!cfg.MQTT_URL) {
      this.log.warn('MQTT_URL not set: control values will not be pushed to MQTT devices');
      return;
    }
    this.client = mqtt.connect(cfg.MQTT_URL, {
      clientId: `svc-api-${process.pid}`,
      username: cfg.MQTT_SERVICE_USERNAME,
      password: cfg.MQTT_SERVICE_PASSWORD,
      protocolVersion: 4,
      reconnectPeriod: 3000,
      connectTimeout: 10_000,
    });
    this.client.on('connect', () => this.log.log(`connected to broker ${cfg.MQTT_URL}`));
    this.client.on('error', (e) => this.log.warn(`broker: ${e.message}`));
  }

  get connected() {
    return !!this.client?.connected;
  }

  /** Resolves true when the broker accepted the message (QoS 1), false when not connected. */
  publishControl(device: { id: string; organization_id: string; project_id: string }, field: string, value: number): Promise<boolean> {
    const client = this.client;
    if (!client?.connected) return Promise.resolve(false);
    const topic = buildTopic({ orgId: device.organization_id, projectId: device.project_id, deviceId: device.id }, 'cmd');
    return new Promise((resolve) => client.publish(topic, controlMessage(field, value), { qos: 1 }, (err) => resolve(!err)));
  }

  /** Publishes a command on the device's cmd topic. Resolves true when the broker accepted it. */
  publishCommand(
    device: { id: string; organization_id: string; project_id: string },
    c: { id: string; name: string; payload: Record<string, unknown>; expiresAt: Date },
  ): Promise<boolean> {
    const client = this.client;
    if (!client?.connected) return Promise.resolve(false);
    const topic = buildTopic({ orgId: device.organization_id, projectId: device.project_id, deviceId: device.id }, 'cmd');
    return new Promise((resolve) => client.publish(topic, commandMessage(c), { qos: 1 }, (err) => resolve(!err)));
  }

  async onModuleDestroy() {
    await new Promise<void>((r) => (this.client ? this.client.end(false, {}, () => r()) : r()));
  }
}
