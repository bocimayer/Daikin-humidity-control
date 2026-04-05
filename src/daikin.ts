/**
 * Daikin Onecta API client.
 *
 * All endpoint paths and payload shapes that require live-API verification are
 * isolated in clearly-marked ADAPTER NOTE comments. Search for "ADAPTER NOTE"
 * to find every location that may need adjustment once you have access to live
 * API docs or a working developer account.
 *
 * Reference docs (private developer portal):
 *   https://developer.onecta.daikineurope.com/
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import logger from './logger';

// ─── Public types ────────────────────────────────────────────────────────────

export type OperationMode = 'cooling' | 'heating' | 'dry' | 'fanOnly' | 'auto';

export interface DaikinDeviceState {
  deviceId: string;
  /** Resolved display name from the API, if available. */
  name: string;
  operationMode: OperationMode | null;
  /** Indoor relative humidity 0-100, or null if the sensor is not present. */
  humidity: number | null;
  /** Current heating/cooling setpoint in °C, or null if not readable. */
  setpointTempC: number | null;
}

// ─── Internal raw-API types (partial — only what we consume) ─────────────────

interface TokenResponse {
  access_token: string;
  /** Seconds until expiry. */
  expires_in: number;
  token_type: string;
}

interface CharacteristicValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  settable: boolean;
  reportable: boolean;
}

interface ManagementPoint {
  /** e.g. "climateControl", "gateway", "sensoryData" */
  managementPointType: string;
  characteristics?: Record<string, CharacteristicValue>;
}

interface RawDevice {
  id: string;
  managementPoints: ManagementPoint[];
}

// ─── DaikinClient ─────────────────────────────────────────────────────────────

export class DaikinClient {
  private readonly http: AxiosInstance;
  private readonly authHttp: AxiosInstance;

  private accessToken: string | null = null;
  /** Unix epoch ms when the current token expires. */
  private tokenExpiresAt = 0;
  /** Minimum remaining token lifetime before we proactively refresh (ms). */
  private readonly tokenRefreshMarginMs = 5 * 60 * 1000;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
    private readonly baseUrl: string,
    private readonly authUrl: string,
  ) {
    this.authHttp = axios.create({ timeout: 15_000 });

    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 20_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Attach OIDC bearer token to every request.
    this.http.interceptors.request.use(async (cfg) => {
      const token = await this.ensureToken();
      cfg.headers = cfg.headers ?? {};
      cfg.headers['Authorization'] = `Bearer ${token}`;
      return cfg;
    });

    // Retry transient errors: network failures, 429, 5xx.
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err: AxiosError) => {
        if (axiosRetry.isNetworkError(err)) return true;
        const status = err.response?.status ?? 0;
        return status === 429 || status >= 500;
      },
      onRetry: (retryCount, err) => {
        logger.warn(
          { retryCount, status: err.response?.status, url: err.config?.url },
          'Retrying Daikin API request',
        );
      },
    });
  }

  // ─── Token management ──────────────────────────────────────────────────────

  /**
   * Returns a valid access token, refreshing it if it is absent or about to expire.
   *
   * ADAPTER NOTE: verify the exact field names expected by the token endpoint.
   * The Onecta IDP is OIDC-compliant; the form below follows the standard
   * refresh_token grant. Adjust if the portal's docs differ.
   */
  private async ensureToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now + this.tokenRefreshMarginMs < this.tokenExpiresAt) {
      return this.accessToken;
    }

    logger.debug({ authUrl: this.authUrl }, 'Refreshing Daikin access token');

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    try {
      const response = await this.authHttp.post<TokenResponse>(this.authUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = now + response.data.expires_in * 1000;
      logger.info(
        { expiresInSeconds: response.data.expires_in },
        'Daikin access token refreshed successfully',
      );
      return this.accessToken;
    } catch (err) {
      logger.error({ err }, 'Failed to refresh Daikin access token');
      throw err;
    }
  }

  // ─── Device listing ────────────────────────────────────────────────────────

  /**
   * Lists all gateway devices visible to the authenticated account.
   *
   * ADAPTER NOTE: endpoint path is GET /v1/gateway-devices.
   * Confirm whether the API uses pagination (Link headers or a "next" cursor).
   * The current implementation assumes the full list is returned in one response.
   */
  async getDevices(): Promise<RawDevice[]> {
    const response = await this.http.get<RawDevice[]>('/v1/gateway-devices');
    return response.data;
  }

  // ─── Device state ──────────────────────────────────────────────────────────

  /**
   * Returns the interpreted state for a single device.
   *
   * ADAPTER NOTE: humidity is read from the "sensoryData" management point,
   * characteristic "sensoryData", sub-key "indoorHumidity.value".
   * Confirm the exact nesting against live API output — it may differ per device
   * model. An alternative path is climateControlInfo → sensoryData → humidity.
   *
   * ADAPTER NOTE: operationMode is read from the "climateControl" management
   * point, characteristic "operationMode".
   *
   * ADAPTER NOTE: setpoint temperature is read from "temperatureControl"
   * characteristic under the nested path:
   *   value.operationModes.heating.setpoints.roomTemperature.value
   */
  async getDeviceState(deviceId: string): Promise<DaikinDeviceState> {
    const response = await this.http.get<RawDevice>(`/v1/gateway-devices/${deviceId}`);
    const device = response.data;
    return this.parseDeviceState(device);
  }

  private parseDeviceState(device: RawDevice): DaikinDeviceState {
    const climateControl = this.findManagementPoint(device, 'climateControl');
    const sensoryData = this.findManagementPoint(device, 'sensoryData');

    const operationMode = this.extractCharacteristicValue<OperationMode>(
      climateControl,
      'operationMode',
    );

    // ADAPTER NOTE: adjust key path if the live API response differs.
    const humidity = this.extractHumidity(sensoryData);

    // ADAPTER NOTE: adjust nested path if the live API response differs.
    const setpointTempC = this.extractSetpointTemp(climateControl);

    const name = this.extractDeviceName(device);

    return { deviceId: device.id, name, operationMode, humidity, setpointTempC };
  }

  // ─── Mode switching ────────────────────────────────────────────────────────

  /**
   * Sets the HVAC operation mode for a device.
   *
   * ADAPTER NOTE: PATCH path is:
   *   /v1/gateway-devices/{deviceId}/management-points/climateControl/characteristics/operationMode
   * Body: { "value": "<mode>" }
   * Confirm exact casing for mode values ("dry" vs "Dry" etc.) against live docs.
   * Confirm "climateControl" is the correct managementPointType for AC units
   * (vs "climateControlInfo").
   */
  async setOperationMode(deviceId: string, mode: OperationMode): Promise<void> {
    const path = this.characteristicPath(deviceId, 'climateControl', 'operationMode');
    logger.debug({ deviceId, mode, path }, 'Setting operation mode');
    await this.http.patch(path, { value: mode });
  }

  /**
   * Sets the heating setpoint temperature for a device (°C).
   *
   * ADAPTER NOTE: PATCH path is:
   *   /v1/gateway-devices/{deviceId}/management-points/climateControl/characteristics/temperatureControl
   * Body shape — confirm the exact nested structure against live docs:
   * {
   *   "value": {
   *     "operationModes": {
   *       "heating": {
   *         "setpoints": {
   *           "roomTemperature": { "value": <number> }
   *         }
   *       }
   *     }
   *   }
   * }
   * Some devices may use a simpler flat body: { "value": <number> }
   */
  async setTemperature(deviceId: string, tempC: number): Promise<void> {
    const path = this.characteristicPath(deviceId, 'climateControl', 'temperatureControl');
    logger.debug({ deviceId, tempC, path }, 'Setting temperature setpoint');
    await this.http.patch(path, {
      value: {
        operationModes: {
          heating: {
            setpoints: {
              roomTemperature: { value: tempC },
            },
          },
        },
      },
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Builds the PATCH URL for a device characteristic.
   * ADAPTER NOTE: confirm management point and characteristic naming conventions.
   */
  private characteristicPath(
    deviceId: string,
    managementPointType: string,
    characteristicType: string,
  ): string {
    return `/v1/gateway-devices/${deviceId}/management-points/${managementPointType}/characteristics/${characteristicType}`;
  }

  private findManagementPoint(
    device: RawDevice,
    type: string,
  ): ManagementPoint | null {
    return device.managementPoints?.find((mp) => mp.managementPointType === type) ?? null;
  }

  private extractCharacteristicValue<T>(
    mp: ManagementPoint | null,
    key: string,
  ): T | null {
    const char = mp?.characteristics?.[key];
    if (char === undefined) return null;
    return (char.value as T) ?? null;
  }

  /**
   * ADAPTER NOTE: extracts indoor humidity from the sensoryData management point.
   * Adjust the key path if your device model reports humidity differently.
   */
  private extractHumidity(sensoryData: ManagementPoint | null): number | null {
    if (!sensoryData?.characteristics) return null;

    // Path 1: sensoryData → sensoryData characteristic → indoorHumidity.value
    const sd = sensoryData.characteristics['sensoryData'];
    if (sd?.value?.indoorHumidity?.value !== undefined) {
      return sd.value.indoorHumidity.value as number;
    }

    // Path 2: direct "indoorHumidity" characteristic
    const ih = sensoryData.characteristics['indoorHumidity'];
    if (ih?.value !== undefined) {
      return ih.value as number;
    }

    return null;
  }

  /**
   * ADAPTER NOTE: extracts the heating room-temperature setpoint.
   * Adjust the nested path based on live API output.
   */
  private extractSetpointTemp(climateControl: ManagementPoint | null): number | null {
    const tc = climateControl?.characteristics?.['temperatureControl'];
    if (!tc) return null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return tc.value?.operationModes?.heating?.setpoints?.roomTemperature?.value ?? null;
  }

  /**
   * ADAPTER NOTE: extracts a human-readable device name.
   * Adjust to match the actual field name in the API response.
   */
  private extractDeviceName(device: RawDevice): string {
    // Some devices expose the name as a characteristic on the gateway management point.
    const gateway = this.findManagementPoint(device, 'gateway');
    const nameCh = gateway?.characteristics?.['name'];
    if (nameCh?.value) return String(nameCh.value);

    // Fallback to device ID.
    return device.id;
  }
}
