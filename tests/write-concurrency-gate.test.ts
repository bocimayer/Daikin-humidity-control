import { WriteConcurrencyGate } from '../src/write-concurrency-gate';

describe('WriteConcurrencyGate', () => {
  it('never runs more than one async fn at a time when maxConcurrent is 1', async () => {
    const gate = new WriteConcurrencyGate(1);
    let overlap = 0;
    let maxOverlap = 0;
    const runSlow = async () => {
      overlap += 1;
      maxOverlap = Math.max(maxOverlap, overlap);
      await new Promise<void>((r) => {
        setTimeout(r, 25);
      });
      overlap -= 1;
    };
    await Promise.all([gate.run(runSlow), gate.run(runSlow)]);
    expect(maxOverlap).toBe(1);
  });

  it('allows up to maxConcurrent overlapping runs', async () => {
    const gate = new WriteConcurrencyGate(2);
    let overlap = 0;
    let maxOverlap = 0;
    const runSlow = async () => {
      overlap += 1;
      maxOverlap = Math.max(maxOverlap, overlap);
      await new Promise<void>((r) => {
        setTimeout(r, 30);
      });
      overlap -= 1;
    };
    await Promise.all([gate.run(runSlow), gate.run(runSlow), gate.run(runSlow)]);
    expect(maxOverlap).toBe(2);
  });

  it('rejects maxConcurrent below 1', () => {
    expect(() => new WriteConcurrencyGate(0)).toThrow(/maxConcurrent/);
  });
});
