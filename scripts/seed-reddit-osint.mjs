#!/usr/bin/env node
/**
 * Reddit OSINT seed — ICE / enforcement subreddit monitoring.
 *
 * Ported from hlidskjalf/src/ingestors/reddit.ts. Pulls Atom feeds from
 * monitored subreddits via old.reddit.com (no OAuth required), geocodes
 * each post against a US-cities centroid map, derives category/severity
 * from text keywords, and writes Incident records into the same Redis
 * zset the local-intel panel reads from (`local-intel:enforcement`).
 *
 * The local-intel/enforcement-detector.ts module reads the same key, so
 * any consumer (panel, geofence engine, Slack alert webhook) sees Reddit
 * incidents identically to citizen-app incidents.
 *
 * Env: REDIS_URL (default: redis://localhost:6379)
 *      REDDIT_SUBREDDITS (optional comma-separated override)
 */

import Redis from 'ioredis';

const USER_AGENT = 'Hlidskjalf/1.0 (OSINT geospatial monitoring; open-source)';

const DEFAULT_SUBREDDITS = ['ICE_Watch', 'ice_raids', 'eyesonice'];

const REDDIT_GEOCODE_MAP = {
  'new york':       { lat: 40.7128, lon: -74.0060 },
  'nyc':            { lat: 40.7128, lon: -74.0060 },
  'brooklyn':       { lat: 40.6782, lon: -73.9442 },
  'bronx':          { lat: 40.8448, lon: -73.8648 },
  'queens':         { lat: 40.7282, lon: -73.7949 },
  'los angeles':    { lat: 34.0522, lon: -118.2437 },
  ' la ':           { lat: 34.0522, lon: -118.2437 },
  'chicago':        { lat: 41.8781, lon: -87.6298 },
  'houston':        { lat: 29.7604, lon: -95.3698 },
  'phoenix':        { lat: 33.4484, lon: -112.0740 },
  'philadelphia':   { lat: 39.9526, lon: -75.1652 },
  'san antonio':    { lat: 29.4241, lon: -98.4936 },
  'san diego':      { lat: 32.7157, lon: -117.1611 },
  'dallas':         { lat: 32.7767, lon: -96.7970 },
  'denver':         { lat: 39.7392, lon: -104.9903 },
  'seattle':        { lat: 47.6062, lon: -122.3321 },
  'portland':       { lat: 45.5051, lon: -122.6750 },
  'miami':          { lat: 25.7617, lon: -80.1918 },
  'atlanta':        { lat: 33.7490, lon: -84.3880 },
  'boston':         { lat: 42.3601, lon: -71.0589 },
  'detroit':        { lat: 42.3314, lon: -83.0458 },
  'minneapolis':    { lat: 44.9778, lon: -93.2650 },
  'washington dc':  { lat: 38.9072, lon: -77.0369 },
  'nashville':      { lat: 36.1627, lon: -86.7816 },
  'memphis':        { lat: 35.1495, lon: -90.0490 },
  'baltimore':      { lat: 39.2904, lon: -76.6122 },
  'charlotte':      { lat: 35.2271, lon: -80.8431 },
  'el paso':        { lat: 31.7619, lon: -106.4850 },
  'tucson':         { lat: 32.2226, lon: -110.9747 },
  'fresno':         { lat: 36.7378, lon: -119.7871 },
  'sacramento':     { lat: 38.5816, lon: -121.4944 },
  'san jose':       { lat: 37.3382, lon: -121.8863 },
  'san francisco':  { lat: 37.7749, lon: -122.4194 },
  'albuquerque':    { lat: 35.0853, lon: -106.6056 },
  'salt lake city': { lat: 40.7608, lon: -111.8910 },
  'las vegas':      { lat: 36.1699, lon: -115.1398 },
  'new orleans':    { lat: 29.9511, lon: -90.0715 },
  'tampa':          { lat: 27.9506, lon: -82.4572 },
  'orlando':        { lat: 28.5383, lon: -81.3792 },
  'richmond':       { lat: 37.5407, lon: -77.4360 },
  'raleigh':        { lat: 35.7796, lon: -78.6382 },
  'omaha':          { lat: 41.2565, lon: -95.9345 },
  'oklahoma city':  { lat: 35.4676, lon: -97.5164 },
  'kansas city':    { lat: 39.0997, lon: -94.5786 },
  'st. louis':      { lat: 38.6270, lon: -90.1994 },
  'st louis':       { lat: 38.6270, lon: -90.1994 },
  'cleveland':      { lat: 41.4993, lon: -81.6944 },
  'pittsburgh':     { lat: 40.4406, lon: -79.9959 },
  'cincinnati':     { lat: 39.1031, lon: -84.5120 },
  'colorado springs': { lat: 38.8339, lon: -104.8214 },
  'bakersfield':    { lat: 35.3733, lon: -119.0187 },
  'long beach':     { lat: 33.7701, lon: -118.1937 },
  'stockton':       { lat: 37.9577, lon: -121.2908 },
  'riverside':      { lat: 33.9806, lon: -117.3755 },
  'santa ana':      { lat: 33.7455, lon: -117.8677 },
  'anaheim':        { lat: 33.8366, lon: -117.9143 },
  'corpus christi': { lat: 27.8006, lon: -97.3964 },
};

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function parseAtomXml(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const body = match[1];
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/.exec(body);
    const title = titleMatch ? decodeXmlEntities(titleMatch[1].trim()) : '';
    if (!title) continue;
    const linkMatch = /<link[^>]+href="([^"]+)"/.exec(body);
    const link = linkMatch ? linkMatch[1] : '';
    const contentMatch = /<content[^>]*>([\s\S]*?)<\/content>/.exec(body);
    const rawContent = contentMatch ? contentMatch[1] : '';
    const updatedMatch =
      /<updated>([\s\S]*?)<\/updated>/.exec(body) ??
      /<published>([\s\S]*?)<\/published>/.exec(body);
    const updated = updatedMatch ? updatedMatch[1].trim() : '';
    const idMatch = /<id>([\s\S]*?)<\/id>/.exec(body);
    const id = idMatch ? idMatch[1].trim() : '';
    entries.push({ title, link, content: rawContent, updated, id });
  }
  return entries;
}

function stripRedditHtml(encoded) {
  const html = decodeXmlEntities(encoded);
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function geocodeRedditPost(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  for (const [keyword, coords] of Object.entries(REDDIT_GEOCODE_MAP)) {
    if (text.includes(keyword)) {
      return { lat: coords.lat, lon: coords.lon, verified: true };
    }
  }
  return { lat: 39.5, lon: -98.35, verified: false };
}

function categorizeRedditPost(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (
    text.includes('protest') || text.includes('rally') ||
    text.includes('demonstration') || text.includes('march')
  ) return 'protest';
  return 'enforcement';
}

function deriveRedditSeverity(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (
    text.includes('happening now') || text.includes('right now') ||
    text.includes('currently') || text.includes('ongoing') ||
    text.includes('active') || text.includes('live update')
  ) return 'warning';
  if (
    text.includes('raid') || text.includes('arrest') ||
    text.includes('detained') || text.includes('checkpoint') ||
    text.includes('multiple') || text.includes('sweep')
  ) return 'watch';
  return 'info';
}

function generateRedditId(subreddit, title, updated) {
  let hash = 0;
  const str = `${subreddit.toLowerCase()}:${title}:${updated}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return `reddit-${subreddit.toLowerCase()}-${Math.abs(hash).toString(16)}`;
}

async function fetchSubredditFeed(subreddit) {
  const url = `https://old.reddit.com/r/${subreddit}/.rss`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/atom+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`r/${subreddit}: HTTP ${resp.status}`);
  return resp.text();
}

function buildIncident(subreddit, entry) {
  const cleanDesc = stripRedditHtml(entry.content);
  const geo = geocodeRedditPost(entry.title, cleanDesc);
  const category = categorizeRedditPost(entry.title, cleanDesc);
  const severity = deriveRedditSeverity(entry.title, cleanDesc);
  const ts = entry.updated ? new Date(entry.updated).getTime() : Date.now();
  return {
    id: generateRedditId(subreddit, entry.title, entry.updated),
    source: 'reddit',
    category,
    title: entry.title,
    body: cleanDesc,
    description: cleanDesc || undefined,
    link: entry.link,
    lat: geo.lat,
    lon: geo.lon,
    neighborhood: subreddit,
    severity,
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
    verified: geo.verified,
  };
}

async function main() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const overrideRaw = process.env.REDDIT_SUBREDDITS;
  const subreddits = overrideRaw
    ? overrideRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SUBREDDITS;

  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();

  let totalNew = 0;
  let totalSeen = 0;
  for (const sub of subreddits) {
    try {
      const xml = await fetchSubredditFeed(sub);
      const entries = parseAtomXml(xml);
      for (const entry of entries) {
        const incident = buildIncident(sub, entry);
        totalSeen++;

        const dedupKey = `reddit:seen:${incident.id}`;
        const claimed = await redis.set(dedupKey, '1', 'EX', 86400 * 7, 'NX');
        if (claimed !== 'OK') continue;
        totalNew++;

        await redis.zadd(
          'local-intel:enforcement',
          incident.timestamp,
          JSON.stringify(incident),
        );

        const spatialKey = `spatial:event:reddit:${incident.id}`;
        await redis.set(
          spatialKey,
          JSON.stringify({
            id: incident.id,
            type: `reddit:${incident.category}`,
            lat: incident.lat,
            lon: incident.lon,
            timestamp: incident.timestamp,
            data: incident,
          }),
          'EX',
          86400 * 7,
        );

        if (incident.verified && incident.severity !== 'info') {
          await redis.zadd(
            'circle0:threats',
            incident.timestamp,
            JSON.stringify({
              source: 'reddit',
              category: incident.category,
              severity: incident.severity,
              lat: incident.lat,
              lon: incident.lon,
              title: incident.title,
              link: incident.link,
              timestamp: incident.timestamp,
            }),
          );
        }
      }
      console.log(`  r/${sub}: ${entries.length} entries`);
    } catch (err) {
      console.warn(`  r/${sub}: ${err.message}`);
    }
  }

  await redis.expire('local-intel:enforcement', 86400 * 30);
  await redis.expire('circle0:threats', 86400 * 7);
  await redis.set('seed:reddit-osint:last_run', String(Date.now()), 'EX', 86400);

  console.log(`reddit-osint: ${totalNew} new / ${totalSeen} seen across ${subreddits.length} subreddits`);
  await redis.quit();
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
