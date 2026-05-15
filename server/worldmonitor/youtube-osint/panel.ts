import type { Context } from 'hono';
import { PatternRegistry } from './pattern-registry.js';

const registry = new PatternRegistry();

export async function youtubePanelHandler(c: Context): Promise<Response> {
  const matches = registry.load().slice(-50);
  return c.json({ matches, timestamp: new Date().toISOString() });
}
