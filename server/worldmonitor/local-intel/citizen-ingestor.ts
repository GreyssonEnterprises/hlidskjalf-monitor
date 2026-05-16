export interface CitizenIncident {
  id: string;
  title: string;
  lat: number;
  lon: number;
  timestamp: number;
  category: string;
}

/**
 * Citizen app ingestor.
 *
 * Citizen does not expose a public API. Real incident data arrives via the
 * seed-unrest-events.mjs script which scrapes available feeds. This class
 * exists as the typed interface boundary — callers can pass fetched incidents
 * through without coupling to the scraper implementation.
 */
export class CitizenIngestor {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetch(_lat: number, _lon: number, _radiusKm: number): Promise<CitizenIncident[]> {
    return [];
  }
}
