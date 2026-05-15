/**
 * Integration test for the worldmonitor event-bus → draupnir hook wiring.
 *
 * Builds an in-memory fake of the Redis subset the draupnir pipeline uses
 * (`set`/`zadd`/`zremrangebyrank`/`rpush`/`expire`/`get`/`zrevrange`/`lrange`/
 * `del`), feeds it to `makeDraupnirHook`, registers the hook, then emits a
 * shipping-keyword WorldEvent and verifies the signal got persisted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emitEvent,
  registerEventHook,
  makeDraupnirHook,
  type WorldEvent,
} from '../server/worldmonitor/events.ts';

class FakeRedis {
  store = new Map<string, string>();
  zsets = new Map<string, Array<[number, string]>>();
  lists = new Map<string, string[]>();

  async set(key: string, value: string, _opt?: string, _ttl?: number): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async zadd(key: string, score: number, member: string): Promise<number> {
    const arr = this.zsets.get(key) ?? [];
    arr.push([score, member]);
    arr.sort((a, b) => a[0] - b[0]);
    this.zsets.set(key, arr);
    return 1;
  }
  async zremrangebyrank(_key: string, _start: number, _stop: number): Promise<number> {
    return 0;
  }
  async zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    const arr = (this.zsets.get(key) ?? []).slice().reverse();
    const end = stop === -1 ? arr.length : stop + 1;
    return arr.slice(start, end).map(([, m]) => m);
  }
  async rpush(key: string, value: string): Promise<number> {
    const arr = this.lists.get(key) ?? [];
    arr.push(value);
    this.lists.set(key, arr);
    return arr.length;
  }
  async lrange(key: string, _start: number, _stop: number): Promise<string[]> {
    return (this.lists.get(key) ?? []).slice();
  }
  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
  }
  async del(key: string): Promise<number> {
    let n = 0;
    if (this.store.delete(key)) n++;
    if (this.zsets.delete(key)) n++;
    if (this.lists.delete(key)) n++;
    return n;
  }
}

describe('makeDraupnirHook — event bus consumer', () => {
  it('persists a classifiable signal when the bus emits a matching event', async () => {
    const redis = new FakeRedis();
    const hook = makeDraupnirHook(redis as unknown as import('ioredis').default);
    registerEventHook(hook);

    const event: WorldEvent = {
      id: 'evt-shipping-1',
      source: 'gdelt',
      category: 'shipping',
      title: 'Container ship blockade at Strait of Hormuz',
      body: 'Vessels rerouting; chokepoint disruption widens',
      severity: 'warning',
      lat: 26.5,
      lon: 56.5,
      timestamp: Date.now(),
    };
    await emitEvent(event);

    // The signal should now exist in the FakeRedis store under draupnir:signal:<id>.
    const raw = await redis.get(`draupnir:signal:${event.id}`);
    assert.ok(raw, 'draupnir:signal:<id> must be persisted by the hook');
    const persisted = JSON.parse(raw) as { id: string; category: string; score: number; actionability: string };
    assert.equal(persisted.id, event.id);
    assert.equal(persisted.category, 'shipping');
    assert.ok(persisted.score >= 0 && persisted.score <= 100);
    assert.ok(['monitor', 'research', 'act'].includes(persisted.actionability));
  });

  it('drops events that match no draupnir category', async () => {
    const redis = new FakeRedis();
    const hook = makeDraupnirHook(redis as unknown as import('ioredis').default);
    registerEventHook(hook);

    await emitEvent({
      id: 'evt-cat-photos',
      source: 'reddit',
      category: 'cute',
      title: 'kittens',
      body: 'fluffy',
      severity: 'info',
      lat: 47,
      lon: -122,
    });

    assert.equal(await redis.get('draupnir:signal:evt-cat-photos'), null);
  });
});
