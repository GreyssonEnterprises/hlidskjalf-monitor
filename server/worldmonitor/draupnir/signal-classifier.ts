export type SignalCategory =
  | 'conflict'
  | 'shipping'
  | 'energy'
  | 'disasters'
  | 'sanctions'
  | 'prediction-markets';

export interface DraupnirSignal {
  id: string;
  category: SignalCategory;
  title: string;
  summary: string;
  lat?: number;
  lon?: number;
  score: number;
  actionability: 'monitor' | 'research' | 'act';
  sectorTags: string[];
  timestamp: number;
  sourceEvent: unknown;
}

const CONFLICT_KEYWORDS = ['war', 'military', 'missile', 'attack', 'airstrike', 'troops', 'escalation', 'ceasefire', 'hostilities', 'conflict', 'battle', 'coup'];
const SHIPPING_KEYWORDS = ['shipping', 'chokepoint', 'strait', 'canal', 'port', 'vessel', 'tanker', 'container', 'maritime', 'blockade', 'disruption'];
const ENERGY_KEYWORDS = ['pipeline', 'refinery', 'oil', 'gas', 'lng', 'energy', 'fuel', 'power', 'electricity', 'grid', 'outage'];
const DISASTER_KEYWORDS = ['earthquake', 'hurricane', 'flood', 'wildfire', 'tsunami', 'eruption', 'cyclone', 'disaster', 'damage', 'destruction'];
const SANCTIONS_KEYWORDS = ['sanctions', 'embargo', 'restriction', 'ban', 'blacklist', 'ofac', 'designation', 'export control'];
const PREDICTION_KEYWORDS = ['probability', 'prediction', 'market', 'polymarket', 'manifold', 'odds', 'forecast', 'likelihood'];

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

export function classifySignalCategory(title: string, body: string): SignalCategory | null {
  const text = `${title} ${body}`;
  if (matchesKeywords(text, PREDICTION_KEYWORDS)) return 'prediction-markets';
  if (matchesKeywords(text, SANCTIONS_KEYWORDS)) return 'sanctions';
  if (matchesKeywords(text, CONFLICT_KEYWORDS)) return 'conflict';
  if (matchesKeywords(text, ENERGY_KEYWORDS)) return 'energy';
  if (matchesKeywords(text, SHIPPING_KEYWORDS)) return 'shipping';
  if (matchesKeywords(text, DISASTER_KEYWORDS)) return 'disasters';
  return null;
}

export function getSectorTags(category: SignalCategory): string[] {
  switch (category) {
    case 'conflict': return ['defense', 'oil-futures', 'regional-etf', 'commodities'];
    case 'shipping': return ['shipping-stocks', 'supply-chain', 'container-rates'];
    case 'energy': return ['oil-gas', 'utilities', 'energy-stocks'];
    case 'disasters': return ['insurance', 'rebuilding', 'regional-impact'];
    case 'sanctions': return ['affected-sectors', 'compliance', 'trade-flows'];
    case 'prediction-markets': return ['leading-indicators', 'all-categories'];
  }
}

export class SignalClassifier {
  classify(event: { title: string; body: string; lat?: number; lon?: number; timestamp: number; id: string }): DraupnirSignal | null {
    const category = classifySignalCategory(event.title, event.body);
    if (!category) return null;
    return {
      id: event.id,
      category,
      title: event.title,
      summary: event.body.slice(0, 200),
      lat: event.lat,
      lon: event.lon,
      score: 0, // set by RelevanceScorer
      actionability: 'monitor', // set by classifyActionability
      sectorTags: getSectorTags(category),
      timestamp: event.timestamp,
      sourceEvent: event,
    };
  }
}
