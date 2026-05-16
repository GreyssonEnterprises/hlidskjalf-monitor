import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

/**
 * Extract the auto-generated transcript for a YouTube video via yt-dlp.
 * Returns null if yt-dlp is unavailable or the video has no captions.
 * Requires yt-dlp to be installed on PATH.
 */
export async function extractTranscript(videoId: string): Promise<string | null> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'yt-'));
  try {
    await execFileAsync(
      'yt-dlp',
      [
        '--write-auto-sub',
        '--skip-download',
        '--sub-format',
        'vtt',
        '--output',
        join(tmpDir, '%(id)s.%(ext)s'),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeout: 60_000 },
    );

    const files = readdirSync(tmpDir);
    const vttFile = files.find((f) => f.endsWith('.vtt'));
    if (!vttFile) return null;

    const content = await readFile(join(tmpDir, vttFile), 'utf-8');

    // Strip VTT header, timestamps, and HTML tags
    return content
      .replace(/WEBVTT[\s\S]*?\n\n/, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> [\s\S]*?\n/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return null;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
