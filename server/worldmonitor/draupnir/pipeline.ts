/**
 * Draupnir pipeline — wire one event end-to-end.
 *
 * Used by both:
 *   - in-process consumers of the correlation engine event feed
 *   - the hourly digest cron (which reads cross-source-signals from Redis)
 *
 * Each event is classified → scored → labelled actionable → persisted.
 */

import { SignalClassifier, type DraupnirSignal } from './signal-classifier.js';
import { RelevanceScorer } from './relevance-scorer.js';
import { classifyActionability } from './actionability.js';
import { DraupnirPersistence } from './persistence.js';

export interface DraupnirPipelineDeps {
  classifier: SignalClassifier;
  scorer: RelevanceScorer;
  persistence: DraupnirPersistence;
}

export interface DraupnirIngestEvent {
  id: string;
  title: string;
  body: string;
  lat?: number;
  lon?: number;
  timestamp: number;
}

/**
 * Push one event through Draupnir. Returns the persisted signal, or `null`
 * when the event was not classifiable as a Draupnir-relevant signal.
 */
export async function processEvent(
  evt: DraupnirIngestEvent,
  deps: DraupnirPipelineDeps,
  priorSignals: DraupnirSignal[] = [],
): Promise<DraupnirSignal | null> {
  const classified = deps.classifier.classify(evt);
  if (!classified) return null;

  classified.score = deps.scorer.score(classified, priorSignals);
  classified.actionability = classifyActionability(classified.score);

  await deps.persistence.save(classified);
  return classified;
}

/** Build a fresh pipeline wired to the supplied Redis client. */
export function createDraupnirPipeline(persistence: DraupnirPersistence): DraupnirPipelineDeps {
  return {
    classifier: new SignalClassifier(),
    scorer: new RelevanceScorer(),
    persistence,
  };
}
