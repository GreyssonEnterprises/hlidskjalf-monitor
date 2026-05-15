#!/usr/bin/env node
/**
 * Local news RSS seed — area-aware Google News watcher.
 *
 * For each Circle 0 protected area, fetches a configurable RSS feed (default:
 * Google News for "<area name> news") and writes matching incidents into the
 * same Redis zsets the local-intel and circle0 panels read from.
 *
 * Config priority:
 *   1. CIRCLE0_CONFIG_PATH env (default: /app/config/circle0.json in container,
 *      ./config/circle0.json for local dev)
 *   2. Per-area `feedUrl` override on the area definition
 *   3. Falls back to Google News RSS query for "<area.name> news"
 *
 * Env: REDIS_URL                 (default: redis://localhost:6379)
 *      CIRCLE0_CONFIG_PATH       (default: ./config/circle0.json)
 *      LOCAL_NEWS_KEYWORDS       (optional CSV — relevance gate, default below)
 */

import Redis from 'ioredis';
import { readFileSync, existsSync } from 'fs';

const USER_AGENT = 'Hlidskjalf/1.0 (OSINT geospatial monitoring; open-source)';

const DEFAULT_KEYWORDS = [
  'ICE', 'immigration', 'enforcement', 'protest', 'rally', 'march',
  'shooting', 'fire', 'earthquake', 'evacuation', 'standoff',
  'road closure', 'power outage', 'active shooter', 'SWAT', 'arrest',
  'raid', 'demonstration',
];

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(s) {
  return decodeXmlEntities(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRssXml(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const body = match[1];
    const titleMatch = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(body);
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';
    const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(body);
    const link = linkMatch ? stripHtml(linkMatch[1]) : '';
    const descMatch = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/.exec(body);
    const description = descMatch ? stripHtml(descMatch[1]) : '';
    const dateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(body);
    const pubDate = dateMatch ? dateMatch[1].trim() : '';
    if (title) items.push({ title, link, description, pubDate });
  }
  return items;
}

function loadAreas() {
  const path = process.env.CIRCLE0_CONFIG_PATH ?? './config/circle0.json';
  if (!existsSync(path)) {
    console.warn(`  no circle0 config at ${path} — nothing to do`);
    return [];
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return data.protectedAreas ?? [];
  } catch (err) {
    console.warn(`  failed to parse circle0 config: ${err.message}`);
    return [];
  }
}

function feedUrlForArea(area) {
  if (area.feedUrl) return area.feedUrl;
  const q = encodeURIComponent(`${area.name} news`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function isRelevant(item, keywords) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  return keywords.some((kw) => text.includes(kw.toLowerCase()));
}

function categorize(item) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  if (/protest|rally|demonstration|march/.test(text)) return 'protest';
  if (/fire|wildfire|evacuation/.test(text)) return 'fire';
  if (/shooting|active shooter|swat|standoff/.test(text)) return 'violence';
  if (/earthquake|quake|tsunami/.test(text)) return 'natural';
  if (/ice|immigration|enforcement|raid|arrest|checkpoint/.test(text)) return 'enforcement';
  if (/power outage|road closure|outage/.test(text)) return 'infrastructure';
  return 'incident';
}

function deriveSeverity(item, category) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  if (/active shooter|standoff|breaking|developing/.test(text)) return 'warning';
  if (category === 'enforcement' && /raid|sweep|checkpoint|multiple/.test(text)) return 'watch';
  if (category === 'fire' && /evacuation|spreading|out of control/.test(text)) return 'warning';
  return 'info';
}

function generateId(area, item) {
  let hash = 0;
  const str = `${area.id}:${item.title}:${item.pubDate}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return `local-news-${area.id}-${Math.abs(hash).toString(16)}`;
}

async function fetchFeed(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function main() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const keywords = (process.env.LOCAL_NEWS_KEYWORDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const filterKeywords = keywords.length > 0 ? keywords : DEFAULT_KEYWORDS;

  const areas = loadAreas();
  if (areas.length === 0) {
    console.log('local-news-rss: no protected areas — exiting');
    return;
  }

  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();

  let totalNew = 0;
  let totalSeen = 0;
  for (const area of areas) {
    try {
      const xml = await fetchFeed(feedUrlForArea(area));
      const items = parseRssXml(xml);
      for (const item of items) {
        if (!isRelevant(item, filterKeywords)) continue;
        totalSeen++;

        const id = generateId(area, item);
        const dedupKey = `local-news:seen:${id}`;
        const claimed = await redis.set(dedupKey, '1', 'EX', 86400 * 7, 'NX');
        if (claimed !== 'OK') continue;
        totalNew++;

        const category = categorize(item);
        const severity = deriveSeverity(item, category);
        const ts = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
        const incident = {
          id,
          source: 'local-news-rss',
          category,
          title: item.title,
          body: item.description,
          description: item.description,
          link: item.link,
          lat: area.lat,
          lon: area.lon,
          neighborhood: area.name,
          areaId: area.id,
          severity,
          timestamp: Number.isFinite(ts) ? ts : Date.now(),
          verified: true,
        };

        await redis.zadd(
          'local-intel:enforcement',
          incident.timestamp,
          JSON.stringify(incident),
        );

        const spatialKey = `spatial:event:local-news:${id}`;
        await redis.set(
          spatialKey,
          JSON.stringify({
            id,
            type: `local-news:${category}`,
            lat: incident.lat,
            lon: incident.lon,
            timestamp: incident.timestamp,
            data: incident,
          }),
          'EX',
          86400 * 7,
        );

        if (severity !== 'info') {
          await redis.zadd(
            'circle0:threats',
            incident.timestamp,
            JSON.stringify({
              source: 'local-news-rss',
              category,
              severity,
              lat: incident.lat,
              lon: incident.lon,
              areaId: area.id,
              title: item.title,
              link: item.link,
              timestamp: incident.timestamp,
            }),
          );
        }
      }
      console.log(`  ${area.name}: ${items.length} items`);
    } catch (err) {
      console.warn(`  ${area.name}: ${err.message}`);
    }
  }

  await redis.expire('local-intel:enforcement', 86400 * 30);
  await redis.expire('circle0:threats', 86400 * 7);
  await redis.set('seed:local-news-rss:last_run', String(Date.now()), 'EX', 86400);

  console.log(
    `local-news-rss: ${totalNew} new / ${totalSeen} relevant across ${areas.length} areas`,
  );
  await redis.quit();
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
