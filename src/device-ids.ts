/**
 * Resolves which gateway devices to control and to read humidity from.
 *
 * Device UUIDs are no longer configured via env: Onecta is the source of truth
 * (GET /v1/gateway-devices). Same list is used for dry-start/stop and for
 * humidity polling (each device may or may not expose humidity — routes already
 * skip nulls).
 *
 * Cross-references:
 *   - Client list: ./daikin.ts (getDevices)
 *   - Task handlers: ./routes.ts
 */

import type { DaikinClient } from './daikin';

/**
 * Returns gateway device IDs visible to the authenticated Onecta account.
 * Empty array means the account lists no devices (callers should no-op or warn).
 */
export async function resolveGatewayDeviceIds(client: DaikinClient): Promise<string[]> {
  const devices = await client.getDevices();
  return devices.map((d) => d.id);
}
