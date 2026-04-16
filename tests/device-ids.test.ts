/**
 * Unit tests for gateway device ID resolution.
 *
 * Cross-references:
 *   - Implementation: ../src/device-ids.ts
 *   - Consumer: ../src/routes.ts
 */

import type { DaikinClient } from '../src/daikin';
import { resolveGatewayDeviceIds } from '../src/device-ids';

describe('resolveGatewayDeviceIds', () => {
  it('returns ids from getDevices in stable order', async () => {
    const client = {
      getDevices: jest.fn().mockResolvedValue([{ id: 'b' }, { id: 'a' }]),
    } as unknown as DaikinClient;
    await expect(resolveGatewayDeviceIds(client)).resolves.toEqual(['b', 'a']);
  });

  it('returns empty array when Onecta lists no devices', async () => {
    const client = {
      getDevices: jest.fn().mockResolvedValue([]),
    } as unknown as DaikinClient;
    await expect(resolveGatewayDeviceIds(client)).resolves.toEqual([]);
  });
});
