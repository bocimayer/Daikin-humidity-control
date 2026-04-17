import type { DaikinClient } from '../src/daikin';
import { buildGatewayDeviceStatusReport } from '../src/gateway-device-status';

jest.mock('../src/device-ids', () => ({
  resolveGatewayDeviceIds: jest.fn(),
}));

const { resolveGatewayDeviceIds } = jest.requireMock('../src/device-ids') as {
  resolveGatewayDeviceIds: jest.Mock;
};

describe('buildGatewayDeviceStatusReport', () => {
  beforeEach(() => {
    resolveGatewayDeviceIds.mockReset();
  });

  it('returns empty devices when Onecta lists none', async () => {
    resolveGatewayDeviceIds.mockResolvedValueOnce([]);
    const client = {} as DaikinClient;
    const report = await buildGatewayDeviceStatusReport(client);
    expect(report.devices).toEqual([]);
    expect(report.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('merges fulfilled and rejected per-device reads', async () => {
    resolveGatewayDeviceIds.mockResolvedValueOnce(['good-id', 'bad-id']);
    const client = {
      getDeviceState: jest.fn().mockImplementation((id: string) => {
        if (id === 'good-id') {
          return Promise.resolve({
            deviceId: 'good-id',
            name: 'Unit A',
            operationMode: 'heating' as const,
            humidity: 45,
            setpointTempC: 16,
          });
        }
        return Promise.reject(new Error('network down'));
      }),
    } as unknown as DaikinClient;

    const report = await buildGatewayDeviceStatusReport(client);

    expect(report.devices).toHaveLength(2);
    expect(report.devices[0]).toMatchObject({
      ok: true,
      deviceId: 'good-id',
      operationMode: 'heating',
    });
    expect(report.devices[1]).toEqual({
      ok: false,
      deviceId: 'bad-id',
      error: 'network down',
    });
  });
});
