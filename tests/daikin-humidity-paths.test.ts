import { DaikinClient } from '../src/daikin';
import type { RawDevice } from '../src/daikin';
import type { RefreshTokenStore } from '../src/token-store';

/** Minimal store so DaikinClient can be constructed; parseGatewayPayload does not call the network. */
function testTokenStore(): RefreshTokenStore {
  return {
    getRefreshToken: async () => 'test-refresh-token',
    saveRefreshToken: async () => {},
    describe: () => 'test-store',
  };
}

function testClient(): DaikinClient {
  return new DaikinClient(
    'test-client-id',
    'test-secret',
    'https://api.onecta.daikineurope.com',
    'https://idp.onecta.daikineurope.com/v1/oidc/token',
    testTokenStore(),
  );
}

describe('parseGatewayPayload humidity (Onecta shapes)', () => {
  const client = testClient();

  it('reads indoorHumidity from climateControl.sensoryData.value map (embedded characteristic)', () => {
    // Live Onecta MPs carry many direct characteristic-shaped keys not listed on ManagementPoint.
    const raw = {
      id: 'gw-1',
      managementPoints: [
        {
          embeddedId: 'climateControl',
          managementPointType: 'climateControl',
          operationMode: { value: 'heating', settable: true, reportable: true },
          sensoryData: {
            value: {
              indoorHumidity: { value: 52, settable: false, reportable: true },
              roomTemperature: { value: 21, settable: false, reportable: true },
            },
            settable: false,
            reportable: true,
          },
        },
        {
          embeddedId: 'gateway',
          managementPointType: 'gateway',
          characteristics: {
            name: { value: 'Room A', settable: false, reportable: true },
          },
        },
      ],
    } as unknown as RawDevice;
    const st = client.parseGatewayPayload(raw);
    expect(st.humidity).toBe(52);
    expect(st.operationMode).toBe('heating');
    expect(st.name).toBe('Room A');
  });

  it('prefers roomHumidity key when present in sensoryData.value map', () => {
    const raw = {
      id: 'gw-2',
      managementPoints: [
        {
          embeddedId: 'climateControlMainZone',
          managementPointType: 'climateControlMainZone',
          operationMode: { value: 'auto', settable: true, reportable: true },
          sensoryData: {
            value: {
              roomHumidity: { value: '48', settable: false, reportable: true },
            },
            settable: false,
            reportable: true,
          },
        },
      ],
    } as unknown as RawDevice;
    const st = client.parseGatewayPayload(raw);
    expect(st.humidity).toBe(48);
    expect(st.operationMode).toBe('auto');
  });

  it('still reads standalone sensoryData management point nested sensoryData characteristic', () => {
    const raw = {
      id: 'gw-3',
      managementPoints: [
        {
          embeddedId: 'climateControl',
          managementPointType: 'climateControl',
          operationMode: { value: 'dry', settable: true, reportable: true },
        },
        {
          embeddedId: 'sensoryData',
          managementPointType: 'sensoryData',
          sensoryData: {
            value: {
              indoorHumidity: { value: 61, settable: false, reportable: true },
            },
            settable: false,
            reportable: true,
          },
        },
      ],
    } as unknown as RawDevice;
    const st = client.parseGatewayPayload(raw);
    expect(st.humidity).toBe(61);
  });
});
