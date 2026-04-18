/**
 * Multi-head Daikin installs share one outdoor unit: mixed indoor modes confuse it.
 * Cross-ref: routes.ts (dry-start / dry-stop / check-humidity).
 */

import type { DaikinClient, OperationMode, RawDevice } from './daikin';
import { readOperationModeFromRawDevice } from './daikin';

/** Onecta "off" / fan-only style standby — compressor off, we still allow humidity-driven dry entry. */
export const DRY_ENTRY_SOURCE_MODES: ReadonlySet<OperationMode> = new Set(['heating', 'fanOnly']);

export type DryStartPreflightFailReason =
  | 'heterogeneous-operation-modes'
  | 'unknown-operation-mode'
  | 'mixed-dry-state'
  | 'disallowed-source-mode'
  | 'already-all-dry';

export type DryStartPreflight =
  | { ok: true; sharedMode: OperationMode; raws: Map<string, RawDevice> }
  | { ok: false; reason: DryStartPreflightFailReason; modesByDeviceId: Record<string, string> };

export type DryStopPreflight =
  | { ok: true }
  | { ok: false; reason: string; modesByDeviceId: Record<string, string> };

export type HumidityClusterGate =
  | { ok: true }
  | { ok: false; reason: string; modesByDeviceId: Record<string, string> };

export interface DeviceClimateRow {
  deviceId: string;
  mode: OperationMode | null;
  humidity: number | null;
}

function modesRecord(rows: { deviceId: string; mode: OperationMode | null }[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const r of rows) {
    o[r.deviceId] = r.mode ?? 'null';
  }
  return o;
}

/**
 * Rules for entering DRY on the whole cluster:
 * - Every device must report a known operationMode (non-null).
 * - All reported modes must match.
 * - No "some dry, some not" (outdoor unit would be inconsistent).
 * - Shared mode must be heating or fanOnly (API has no literal "off"; fanOnly is treated as off).
 * - If already all dry, caller should skip (nothing to start).
 */
export function evaluateDryStartPreflight(
  deviceIds: string[],
  raws: Map<string, RawDevice>,
): DryStartPreflight {
  const modesByDeviceId: Record<string, string> = {};
  const modes: (OperationMode | null)[] = [];

  for (const id of deviceIds) {
    const raw = raws.get(id);
    if (!raw) {
      return { ok: false, reason: 'unknown-operation-mode', modesByDeviceId: {} };
    }
    const m = readOperationModeFromRawDevice(raw);
    modes.push(m);
    modesByDeviceId[id] = m ?? 'null';
  }

  if (modes.some((m) => m === null)) {
    return { ok: false, reason: 'unknown-operation-mode', modesByDeviceId };
  }

  const anyDry = modes.some((m) => m === 'dry');
  const allDry = modes.every((m) => m === 'dry');
  if (anyDry && !allDry) {
    return { ok: false, reason: 'mixed-dry-state', modesByDeviceId };
  }

  const sharedMode = modes[0] as OperationMode;
  if (!modes.every((m) => m === sharedMode)) {
    return { ok: false, reason: 'heterogeneous-operation-modes', modesByDeviceId };
  }

  if (allDry) {
    return { ok: false, reason: 'already-all-dry', modesByDeviceId };
  }

  if (!DRY_ENTRY_SOURCE_MODES.has(sharedMode)) {
    return { ok: false, reason: 'disallowed-source-mode', modesByDeviceId };
  }

  return { ok: true, sharedMode, raws };
}

/**
 * Restore/stop DRY only when every head reports the same mode and that mode is dry.
 * Homogeneous non-dry → skip (nothing to restore / avoids confusing the outdoor unit).
 */
export function evaluateDryStopPreflight(rows: DeviceClimateRow[]): DryStopPreflight {
  if (rows.length === 0) {
    return { ok: false, reason: 'no-devices', modesByDeviceId: {} };
  }

  const modesByDeviceId = modesRecord(rows);
  if (rows.some((r) => r.mode === null)) {
    return { ok: false, reason: 'unknown-operation-mode', modesByDeviceId };
  }

  const anyDry = rows.some((r) => r.mode === 'dry');
  const allDry = rows.every((r) => r.mode === 'dry');
  if (anyDry && !allDry) {
    return { ok: false, reason: 'mixed-dry-state', modesByDeviceId };
  }

  const shared = rows[0].mode as OperationMode;
  if (!rows.every((r) => r.mode === shared)) {
    return { ok: false, reason: 'heterogeneous-operation-modes', modesByDeviceId };
  }

  if (shared !== 'dry') {
    return { ok: false, reason: 'cluster-not-in-dry', modesByDeviceId };
  }

  return { ok: true };
}

/**
 * Humidity task may only reason about RH when the cluster is mode-consistent (same rules as dry-start
 * for mixed-dry / heterogeneous / unknown). Humidity is read from sensoryData in parseDeviceState and
 * does not depend on operationMode in code — whether fanOnly units report RH is device/API dependent.
 */
export function evaluateHumidityAutomationCluster(rows: DeviceClimateRow[]): HumidityClusterGate {
  if (rows.length === 0) {
    return { ok: false, reason: 'no-devices', modesByDeviceId: {} };
  }

  const modesByDeviceId = modesRecord(rows);
  if (rows.some((r) => r.mode === null)) {
    return { ok: false, reason: 'unknown-operation-mode', modesByDeviceId };
  }

  const anyDry = rows.some((r) => r.mode === 'dry');
  const allDry = rows.every((r) => r.mode === 'dry');
  if (anyDry && !allDry) {
    return { ok: false, reason: 'mixed-dry-state', modesByDeviceId };
  }

  const shared = rows[0].mode as OperationMode;
  if (!rows.every((r) => r.mode === shared)) {
    return { ok: false, reason: 'heterogeneous-operation-modes', modesByDeviceId };
  }

  return { ok: true };
}

/** Sequential GETs to reduce 429 bursts vs Promise.all on many heads. */
export async function fetchGatewayRawsSequential(
  client: DaikinClient,
  deviceIds: string[],
): Promise<Map<string, RawDevice>> {
  const raws = new Map<string, RawDevice>();
  for (const id of deviceIds) {
    raws.set(id, await client.getGatewayDeviceRaw(id));
  }
  return raws;
}
