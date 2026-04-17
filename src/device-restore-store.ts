/**
 * Persists per-device Onecta snapshots in Firestore so dry-stop can restore after Cloud Run scales.
 * Cross-ref: routes.ts executeDryStart/executeDryStop, daikin.ts collectSettableCharacteristicsSnapshot.
 */

import { FieldValue, Firestore } from '@google-cloud/firestore';
import type { SettableCharacteristicEntry } from './daikin';

export type StoredDeviceSnapshot = {
  entries: SettableCharacteristicEntry[];
  capturedAt: string;
};

function sanitizeDocId(deviceId: string): string {
  return deviceId.replace(/\//g, '_');
}

export class DeviceRestoreStore {
  private readonly db = new Firestore();

  constructor(private readonly collectionName: string) {}

  private doc(deviceId: string) {
    return this.db.collection(this.collectionName).doc(sanitizeDocId(deviceId));
  }

  async save(deviceId: string, snapshot: StoredDeviceSnapshot): Promise<void> {
    await this.doc(deviceId).set({
      entries: snapshot.entries,
      capturedAt: snapshot.capturedAt,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  async load(deviceId: string): Promise<StoredDeviceSnapshot | null> {
    const snap = await this.doc(deviceId).get();
    if (!snap.exists) {
      return null;
    }
    const data = snap.data();
    if (!data || !Array.isArray(data.entries)) {
      return null;
    }
    return {
      entries: data.entries as SettableCharacteristicEntry[],
      capturedAt: String(data.capturedAt ?? ''),
    };
  }

  async delete(deviceId: string): Promise<void> {
    await this.doc(deviceId).delete();
  }
}
