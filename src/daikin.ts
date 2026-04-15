/**
 * Daikin Onecta API client.
 *
 * All endpoint paths and payload shapes that require live-API verification are
 * isolated in clearly-marked ADAPTER NOTE comments. Search for "ADAPTER NOTE"
 * to find every location that may need adjustment once you have access to live
 * API docs or a working developer account.
 *
 * Reference docs (private developer portal):
 *   https://developer.cloud.daikineurope.com/
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import logger from './logger';
import { RefreshTokenStore } from './token-store';

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
  /** Some IdPs rotate refresh tokens on each use — must replace stored value. */
  refresh_token?: string;
}

interface CharacteristicValue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  settable: boolean;
  reportable: boolean;
}

interface ManagementPoint {
  /** Live Onecta payloads use `embeddedId` (see daikin-controller-cloud). */
  embeddedId?: string;
  /** Some responses may use this instead of `embeddedId`. */
  managementPointType?: string;
  /** Older / alternate shape: characteristics nested under a map. */
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
  private currentRefreshToken: string;
  /** Minimum remaining token lifetime before we proactively refresh (ms). */
  private readonly tokenRefreshMarginMs = 5 * 60 * 1000;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly baseUrl: string,
    private readonly authUrl: string,
    private readonly refreshTokenStore: RefreshTokenStore,
  ) {
    this.currentRefreshToken = '';
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

    if (!this.currentRefreshToken) {
      this.currentRefreshToken = await this.refreshTokenStore.getRefreshToken();
      logger.info(
        { tokenStore: this.refreshTokenStore.describe() },
        'Loaded Daikin refresh token from token store',
      );
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.currentRefreshToken,
    });

    try {
      const response = await this.authHttp.post<TokenResponse>(this.authUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      this.accessToken = response.data.access_token;
      this.tokenExpiresAt = now + response.data.expires_in * 1000;
      if (response.data.refresh_token) {
        this.currentRefreshToken = response.data.refresh_token;
        await this.refreshTokenStore.saveRefreshToken(response.data.refresh_token, 'token-refresh');
        logger.warn(
          { tokenStore: this.refreshTokenStore.describe() },
          'Onecta returned a new refresh_token (rotation). Persisted the latest refresh token to the configured token store.',
        );
      }
      logger.info(
        { expiresInSeconds: response.data.expires_in },
        'Daikin access token refreshed successfully',
      );
      return this.accessToken;
    } catch (err) {
      const ax = err as AxiosError<{ error?: string; error_description?: string }>;
      logger.error(
        {
          message: ax.message,
          status: ax.response?.status,
          oauthError: ax.response?.data?.error,
          oauthDescription: ax.response?.data?.error_description,
        },
        'Failed to refresh Daikin access token',
      );
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
    const response = await this.http.get<unknown>('/v1/gateway-devices');
    const data = response.data;
    if (Array.isArray(data)) {
      return data as RawDevice[];
    }
    if (data && typeof data === 'object') {
      const o = data as Record<string, unknown>;
      for (const key of ['data', 'gatewayDevices', 'devices', 'items']) {
        const v = o[key];
        if (Array.isArray(v)) {
          return v as RawDevice[];
        }
      }
    }
    logger.warn({ dataType: typeof data }, 'Unexpected gateway-devices response shape');
    return [];
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
    const device = await this.getGatewayDeviceRaw(deviceId);
    return this.parseDeviceState(device);
  }

  /**
   * Raw GET /v1/gateway-devices/{id} payload (for debugging / adapter work).
   */
  async getGatewayDeviceRaw(deviceId: string): Promise<RawDevice> {
    const response = await this.http.get<RawDevice>(`/v1/gateway-devices/${deviceId}`);
    return response.data;
  }

  private parseDeviceState(device: RawDevice): DaikinDeviceState {
    const climateControl =
      this.findManagementPoint(device, 'climateControl') ??
      this.findManagementPoint(device, 'climateControlInfo');
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
    const mpSlug = await this.getClimateManagementPointSlug(deviceId);
    const path = this.characteristicPath(deviceId, mpSlug, 'operationMode');
    logger.debug({ deviceId, mode, path, mpSlug }, 'Setting operation mode');
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
    const mpSlug = await this.getClimateManagementPointSlug(deviceId);
    const path = this.characteristicPath(deviceId, mpSlug, 'temperatureControl');
    logger.debug({ deviceId, tempC, path, mpSlug }, 'Setting temperature setpoint');
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

  /**
   * PATCH URLs must use the device’s real management-point id (`embeddedId`),
   * e.g. `climateControl` or `climateControlInfo`.
   */
  private async getClimateManagementPointSlug(deviceId: string): Promise<string> {
    const device = await this.getGatewayDeviceRaw(deviceId);
    const mp =
      this.findManagementPoint(device, 'climateControl') ??
      this.findManagementPoint(device, 'climateControlInfo');
    if (!mp) {
      logger.warn({ deviceId }, 'No climate management point; using climateControl');
      return 'climateControl';
    }
    return String(mp.embeddedId ?? mp.managementPointType ?? 'climateControl');
  }

  private findManagementPoint(
    device: RawDevice,
    type: string,
  ): ManagementPoint | null {
    return (
      device.managementPoints?.find(
        (mp) => mp.managementPointType === type || mp.embeddedId === type,
      ) ?? null
    );
  }

  /**
   * Onecta returns datapoints either under `characteristics.name` or as direct
   * fields on the management point object (`operationMode`, `temperatureControl`, …).
   */
  private getCharacteristic(
    mp: ManagementPoint | null,
    key: string,
  ): CharacteristicValue | undefined {
    if (!mp) return undefined;
    const nested = mp.characteristics?.[key];
    if (nested) return nested;
    const direct = (mp as Record<string, unknown>)[key];
    if (direct && typeof direct === 'object' && direct !== null && 'value' in direct) {
      return direct as CharacteristicValue;
    }
    return undefined;
  }

  private extractCharacteristicValue<T>(
    mp: ManagementPoint | null,
    key: string,
  ): T | null {
    const char = this.getCharacteristic(mp, key);
    if (char === undefined) return null;
    return (char.value as T) ?? null;
  }

  /**
   * ADAPTER NOTE: extracts indoor humidity from the sensoryData management point.
   * Adjust the key path if your device model reports humidity differently.
   */
  private extractHumidity(sensoryData: ManagementPoint | null): number | null {
    if (!sensoryData) return null;

    // Path 1: sensoryData → sensoryData characteristic → indoorHumidity.value
    const sd = this.getCharacteristic(sensoryData, 'sensoryData');
    if (sd?.value?.indoorHumidity?.value !== undefined) {
      return sd.value.indoorHumidity.value as number;
    }

    // Path 2: direct "indoorHumidity" characteristic
    const ih = this.getCharacteristic(sensoryData, 'indoorHumidity');
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
    const tc = this.getCharacteristic(climateControl, 'temperatureControl');
    if (!tc) return null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return tc.value?.operationModes?.heating?.setpoints?.roomTemperature?.value ?? null;
  }

  /**
   * ADAPTER NOTE: extracts a human-readable device name.
   * Adjust to match the actual field name in the API response.
   */
  private extractDeviceName(device: RawDevice): string {
    const gateway = this.findManagementPoint(device, 'gateway');
    const nameCh = this.getCharacteristic(gateway, 'name');
    if (nameCh?.value) return String(nameCh.value);

    // Fallback to device ID.
    return device.id;
  }
}
