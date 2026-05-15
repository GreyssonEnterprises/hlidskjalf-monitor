#!/usr/bin/env node
/**
 * YouTube OSINT seed — single-pass RSS poll + transcript + Fabric pipeline.
 *
 * Drives the youtube-osint module from a cron poller (every 20 min). For each
 * monitored channel, fetches the latest video entries from the channel Atom
 * RSS feed, extracts auto-generated transcripts via yt-dlp, runs Fabric/Ollama
 * patterns against the transcript, and appends matches to the pattern registry.
 *
 * Channel list is read from YOUTUBE_CHANNELS env (CSV of YouTube channel IDs)
 * or from /app/config/youtube-osint.json (`{ channels: [{id, name}] }`).
 *
 * Note on subprocess execution: yt-dlp is invoked via execFile (NOT exec) which
 * passes argv as an array to the kernel — no shell expansion, no command
 * injection surface. The only argv we control is a YouTube channel ID and a
 * watch URL built from a videoId, both validated upstream.
 *
 * Env: YOUTUBE_CHANNELS         comma-separated channel IDs (UCxxxxxx...)
 *      YOUTUBE_CONFIG_PATH      JSON config (default: ./config/youtube-osint.json)
 *      YOUTUBE_REGISTRY_PATH    pattern registry file (default: ./data/youtube-patterns.json)
 *      FABRIC_API_URL / OLLAMA_URL  Fabric or Ollama endpoint
 *      FABRIC_MODEL             model name (default: llama3)
 *      REDIS_URL                used only for seed:*:last_run heartbeat
 */

import Redis from 'ioredis';
import * as nodeProcSpawn from 'node:child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

// execFile (not exec) — argv array passed directly to the kernel, no shell
const runProc = promisify(nodeProcSpawn.execFile);

const REGISTRY_PATH = process.env.YOUTUBE_REGISTRY_PATH ?? './data/youtube-patterns.json';
const CONFIG_PATH = process.env.YOUTUBE_CONFIG_PATH ?? './config/youtube-osint.json';
const FABRIC_API = process.env.FABRIC_API_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
const FABRIC_MODEL = process.env.FABRIC_MODEL ?? 'llama3';
const FABRIC_PATTERNS = ['extract_wisdom', 'summarize', 'extract_extraordinary_claims'];
const MAX_VIDEOS_PER_CHANNEL = 3;

function loadChannels() {
  const env = process.env.YOUTUBE_CHANNELS;
  if (env) {
    return env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((id) => ({ id, name: id }));
  }
  if (existsSync(CONFIG_PATH)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      return data.channels ?? [];
    } catch (err) {
      console.warn(`  failed to parse ${CONFIG_PATH}: ${err.message}`);
    }
  }
  return [];
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

async function saveRegistry(entries) {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(entries.slice(-1000), null, 2));
}

function parseChannelFeed(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const body = match[1];
    const idMatch = /<yt:videoId>([\s\S]*?)<\/yt:videoId>/.exec(body);
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(body);
    const publishedMatch = /<published>([\s\S]*?)<\/published>/.exec(body);
    const videoId = idMatch ? idMatch[1].trim() : '';
    if (!videoId) continue;
    entries.push({
      videoId,
      title: titleMatch ? titleMatch[1].trim() : '',
      published: publishedMatch ? publishedMatch[1].trim() : '',
    });
  }
  return entries;
}

async function fetchChannel(channelId) {
  if (!/^[A-Za-z0-9_-]+$/.test(channelId)) {
    throw new Error(`bad channel id: ${channelId}`);
  }
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`channel ${channelId}: HTTP ${resp.status}`);
  return resp.text();
}

async function extractTranscript(videoId) {
  // Strict whitelist on videoId — yt-dlp gets argv array, no shell substitution
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) {
    throw new Error(`bad video id: ${videoId}`);
  }
  const tmp = await mkdtemp(join(tmpdir(), 'yt-'));
  try {
    await runProc(
      'yt-dlp',
      [
        '--write-auto-sub',
        '--skip-download',
        '--sub-format', 'vtt',
        '--output', join(tmp, '%(id)s.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 60_000 },
    );
    const files = readdirSync(tmp);
    const vtt = files.find((f) => f.endsWith('.vtt'));
    if (!vtt) return null;
    const content = await readFile(join(tmp, vtt), 'utf-8');
    return content
      .replace(/WEBVTT[\s\S]*?\n\n/, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> [\s\S]*?\n/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (err) {
    console.warn(`    transcript ${videoId}: ${(err.message || '').slice(0, 100)}`);
    return null;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runFabric(text) {
  const results = [];
  for (const pattern of FABRIC_PATTERNS) {
    try {
      const res = await fetch(`${FABRIC_API}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: FABRIC_MODEL,
          prompt: `${pattern}:\n\n${text.slice(0, 8000)}`,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      results.push({ pattern, summary: data.response, events: [] });
    } catch {
      // Fabric/Ollama unavailable — skip pattern
    }
  }
  return results;
}

async function main() {
  const channels = loadChannels();
  if (channels.length === 0) {
    console.log('youtube-osint: no channels configured — exiting');
    return;
  }

  const registry = loadRegistry();
  const seen = new Set(registry.map((m) => `${m.videoId}:${m.pattern}`));

  let added = 0;
  for (const channel of channels) {
    try {
      const xml = await fetchChannel(channel.id);
      const entries = parseChannelFeed(xml).slice(0, MAX_VIDEOS_PER_CHANNEL);
      for (const entry of entries) {
        if (FABRIC_PATTERNS.every((p) => seen.has(`${entry.videoId}:${p}`))) continue;

        console.log(`  ${channel.name || channel.id} — ${entry.videoId}: ${entry.title.slice(0, 60)}`);
        const transcript = await extractTranscript(entry.videoId);
        if (!transcript) continue;

        const matches = await runFabric(transcript);
        for (const m of matches) {
          const key = `${entry.videoId}:${m.pattern}`;
          if (seen.has(key)) continue;
          seen.add(key);
          registry.push({
            videoId: entry.videoId,
            channelId: channel.id,
            channelName: channel.name,
            title: entry.title,
            published: entry.published,
            pattern: m.pattern,
            summary: m.summary,
            timestamp: Date.now(),
          });
          added++;
        }
      }
    } catch (err) {
      console.warn(`  ${channel.name || channel.id}: ${err.message}`);
    }
  }

  if (added > 0) await saveRegistry(registry);

  try {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    await redis.set('seed:youtube-osint:last_run', String(Date.now()), 'EX', 86400);
    await redis.quit();
  } catch (err) {
    console.warn(`  heartbeat write failed: ${err.message}`);
  }

  console.log(`youtube-osint: ${added} new pattern matches across ${channels.length} channels`);
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
