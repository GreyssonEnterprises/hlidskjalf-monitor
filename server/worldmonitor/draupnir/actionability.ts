export type Actionability = 'monitor' | 'research' | 'act';

export function classifyActionability(score: number): Actionability {
  if (score > 70) return 'act';
  if (score >= 40) return 'research';
  return 'monitor';
}
