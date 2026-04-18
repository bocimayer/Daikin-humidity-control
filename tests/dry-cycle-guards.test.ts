import type { RawDevice } from '../src/daikin';
import {
  DRY_ENTRY_SOURCE_MODES,
  evaluateDryStartPreflight,
  evaluateDryStopPreflight,
  evaluateHumidityAutomationCluster,
} from '../src/dry-cycle-guards';

function rawWithMode(mode: string): RawDevice {
  return {
    id: 'x',
    managementPoints: [
      {
        managementPointType: 'climateControl',
        embeddedId: 'climateControl',
        characteristics: {
          operationMode: { value: mode, settable: true, reportable: true },
        },
      },
    ],
  } as RawDevice;
}

describe('dry-cycle-guards', () => {
  it('exports dry entry modes heating and fanOnly only', () => {
    expect(DRY_ENTRY_SOURCE_MODES.has('heating')).toBe(true);
    expect(DRY_ENTRY_SOURCE_MODES.has('fanOnly')).toBe(true);
    expect(DRY_ENTRY_SOURCE_MODES.has('cooling')).toBe(false);
  });

  it('evaluateDryStartPreflight rejects heterogeneous modes', () => {
    const raws = new Map([
      ['a', rawWithMode('heating')],
      ['b', rawWithMode('cooling')],
    ]);
    const out = evaluateDryStartPreflight(['a', 'b'], raws);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('heterogeneous-operation-modes');
  });

  it('evaluateDryStartPreflight rejects cooling when homogeneous', () => {
    const raws = new Map([
      ['a', rawWithMode('cooling')],
      ['b', rawWithMode('cooling')],
    ]);
    const out = evaluateDryStartPreflight(['a', 'b'], raws);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('disallowed-source-mode');
  });

  it('evaluateDryStartPreflight accepts homogeneous heating', () => {
    const raws = new Map([
      ['a', rawWithMode('heating')],
      ['b', rawWithMode('heating')],
    ]);
    const out = evaluateDryStartPreflight(['a', 'b'], raws);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.sharedMode).toBe('heating');
  });

  it('evaluateDryStartPreflight rejects mixed dry', () => {
    const raws = new Map([
      ['a', rawWithMode('dry')],
      ['b', rawWithMode('heating')],
    ]);
    const out = evaluateDryStartPreflight(['a', 'b'], raws);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('mixed-dry-state');
  });

  it('evaluateDryStopPreflight rejects homogeneous non-dry', () => {
    const rows = [
      { deviceId: 'a', mode: 'heating' as const, humidity: 55 },
      { deviceId: 'b', mode: 'heating' as const, humidity: 55 },
    ];
    const out = evaluateDryStopPreflight(rows);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('cluster-not-in-dry');
  });

  it('evaluateDryStopPreflight rejects dry mixed with heating', () => {
    const rows = [
      { deviceId: 'a', mode: 'dry' as const, humidity: 55 },
      { deviceId: 'b', mode: 'heating' as const, humidity: 55 },
    ];
    const out = evaluateDryStopPreflight(rows);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('mixed-dry-state');
  });

  it('evaluateDryStopPreflight passes when all dry', () => {
    const rows = [
      { deviceId: 'a', mode: 'dry' as const, humidity: 55 },
      { deviceId: 'b', mode: 'dry' as const, humidity: 56 },
    ];
    expect(evaluateDryStopPreflight(rows).ok).toBe(true);
  });

  it('evaluateHumidityAutomationCluster rejects mixed dry', () => {
    const rows = [
      { deviceId: 'a', mode: 'dry' as const, humidity: 55 },
      { deviceId: 'b', mode: 'heating' as const, humidity: 55 },
    ];
    const out = evaluateHumidityAutomationCluster(rows);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('mixed-dry-state');
  });
});
