/**
 * Read-only snapshot of all gateway devices from Onecta (operation mode, humidity, setpoint).
 * Used by GET /tasks/device-status (routes.ts). Cross-ref: daikin.ts getDeviceState, device-ids.ts.
 */

import type { DaikinClient, DaikinDeviceState } from './daikin';
import { resolveGatewayDeviceIds } from './device-ids';

export type DeviceStatusRow =
  | ({ ok: true } & DaikinDeviceState)
  | { ok: false; deviceId: string; error: string };

export async function buildGatewayDeviceStatusReport(client: DaikinClient): Promise<{
  ts: string;
  devices: DeviceStatusRow[];
}> {
  const ts = new Date().toISOString();
  const deviceIds = await resolveGatewayDeviceIds(client);
  if (deviceIds.length === 0) {
    return { ts, devices: [] };
  }

  const stateResults = await Promise.allSettled(
    deviceIds.map((id) => client.getDeviceState(id)),
  );

  const devices: DeviceStatusRow[] = stateResults.map((result, idx) => {
    const deviceId = deviceIds[idx];
    if (result.status === 'fulfilled') {
      return { ok: true as const, ...result.value };
    }
    const error =
      result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { ok: false, deviceId, error };
  });

  return { ts, devices };
}
