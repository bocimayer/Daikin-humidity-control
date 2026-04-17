import { readFileSync } from 'fs';
import path from 'path';
import type { RawDevice } from '../src/daikin';
import {
  collectSettableCharacteristicsSnapshot,
  sortSnapshotEntriesForRestore,
} from '../src/daikin';

const sample = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'onecta-raw-device-sample.json'), 'utf8'),
) as RawDevice;

describe('collectSettableCharacteristicsSnapshot', () => {
  it('collects every settable characteristic across management points', () => {
    const entries = collectSettableCharacteristicsSnapshot(sample);
    const keys = entries.map((e) => `${e.mpSlug}:${e.characteristicKey}`).sort();
    expect(keys).toEqual([
      'climateControl:fanSpeed',
      'climateControl:operationMode',
      'climateControl:temperatureControl',
    ]);
    expect(entries.find((e) => e.characteristicKey === 'operationMode')?.value).toBe('heating');
  });

  it('orders operationMode last in restore sort', () => {
    const entries = collectSettableCharacteristicsSnapshot(sample);
    const ordered = sortSnapshotEntriesForRestore(entries);
    expect(ordered[ordered.length - 1].characteristicKey).toBe('operationMode');
  });
});
