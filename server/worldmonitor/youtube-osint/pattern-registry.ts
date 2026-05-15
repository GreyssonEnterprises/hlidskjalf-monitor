import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface PatternMatch {
  videoId: string;
  pattern: string;
  summary: string;
  timestamp: number;
}

const REGISTRY_PATH =
  process.env.YOUTUBE_REGISTRY_PATH ?? '/app/data/youtube-patterns.json';

export class PatternRegistry {
  load(): PatternMatch[] {
    if (!existsSync(REGISTRY_PATH)) return [];
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as PatternMatch[];
  }

  save(matches: PatternMatch[]): void {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(matches, null, 2));
  }

  add(match: PatternMatch): void {
    const all = this.load();
    all.push(match);
    this.save(all.slice(-1000)); // keep last 1000 entries
  }
}
