/*
 * The demo, as a moving picture: start the server in demo
 * mode in a scratch home, open the dashboard where it lands — Failures —
 * in a recorded browser, look at a failure, and turn the recording into
 * the GIF the README carries and the MP4 the site keeps.
 *
 *   npm run build && npx tsx scripts/demo-media.mts
 *
 * Writes docs/assets/demo.gif (≤ 3 MB, the README's) and
 * website/public/demo.mp4 (the source). Needs ffmpeg on PATH. Playwright
 * records WebM; ffmpeg makes the GIF with a two-pass palette so it stays
 * small and readable, and the MP4 with h264 for the site.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.DEMO_MEDIA_PORT ?? 6923);
const GIF = join(root, 'docs', 'assets', 'demo.gif');
const MP4 = join(root, 'website', 'public', 'demo.mp4');
const GIF_CAP_BYTES = 3 * 1024 * 1024;
const WIDTH = 1280;
const HEIGHT = 720;
const GIF_WIDTH = 960;
const GIF_FPS = 10;

function ffmpeg(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} exited ${res.status}`);
}

async function waitForHealth(base: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${base}/api/v1/health`);
      if (res.ok || res.status === 503) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the demo server did not answer on ${base}`);
}

async function main(): Promise<void> {
  if (!existsSync(join(root, 'dist', 'index.js'))) throw new Error('build first: npm run build');
  const home = mkdtempSync(join(tmpdir(), 'iris-demo-media-'));
  const videoDir = mkdtempSync(join(tmpdir(), 'iris-demo-video-'));
  const server = spawn(process.execPath, [join(root, 'dist', 'index.js'), '--demo', '--dashboard-port', String(PORT)], {
    cwd: root,
    env: { ...process.env, IRIS_HOME: home, IRIS_NO_AUTO_LAUNCH: '1', IRIS_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await waitForHealth(base);
    const browser = await chromium.launch();
    // A warm-up pass in a context that is not recorded: the server's first reads and the dashboard's first paint are the slow ones, and a GIF that opens on "Loading…" is a GIF that opens on nothing.
    const warm = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    const warmPage = await warm.newPage();
    await warmPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await warmPage.waitForSelector('a[href^="/moments/"]', { timeout: 20_000 });
    await warmPage.goto(`${base}/runs`, { waitUntil: 'networkidle' });
    await warm.close();
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      recordVideo: { dir: videoDir, size: { width: WIDTH, height: HEIGHT } },
    });
    const recordingStart = Date.now(); // the video starts with the page
    const page = await context.newPage();
    // The landing: Failures, worst and newest first.
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('a[href^="/moments/"]', { timeout: 20_000 });
    await page.waitForFunction(() => !document.body.innerText.includes('Loading'), null, { timeout: 20_000 });
    // Everything before this instant is the page loading; the picture starts here.
    const trimSeconds = ((Date.now() - recordingStart) / 1000 + 0.3).toFixed(2);
    await page.waitForTimeout(2_200);
    // A slow look down the list.
    await page.mouse.wheel(0, 320);
    await page.waitForTimeout(1_400);
    await page.mouse.wheel(0, -320);
    await page.waitForTimeout(900);
    // Open the first failure: the moment, with the rule and its evidence (MomentCard links to /moments/:id).
    const first = page.locator('a[href^="/moments/"]').first();
    if ((await first.count()) > 0) {
      await first.hover();
      await page.waitForTimeout(500);
      await first.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2_600);
      await page.mouse.wheel(0, 260);
      await page.waitForTimeout(1_600);
    }
    // Runs: two runs compared with an interval.
    await page.goto(`${base}/runs`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_200);
    await context.close();
    await browser.close();
    const webm = readdirSync(videoDir)
      .filter((f) => f.endsWith('.webm'))
      .map((f) => join(videoDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!webm) throw new Error('no recording was written');
    const source = join(videoDir, 'demo.webm');
    renameSync(webm, source);

    // The loading seconds are cut, measured above; the picture starts on the landing.
    const TRIM = ['-ss', trimSeconds];
    process.stdout.write(`trimming the first ${trimSeconds} s (the load)\n`);
    // The MP4 the site keeps: h264, yuv420p so every player takes it.
    ffmpeg([...TRIM, '-i', source, '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', MP4]);
    // The GIF the README carries: a palette pass, then the encode; smaller until it fits.
    const palette = join(videoDir, 'palette.png');
    for (const [width, fps] of [
      [GIF_WIDTH, GIF_FPS],
      [800, 8],
      [720, 8],
      [640, 6],
    ] as Array<[number, number]>) {
      const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
      ffmpeg([...TRIM, '-i', source, '-vf', `${filters},palettegen=max_colors=128:stats_mode=diff`, palette]);
      ffmpeg([...TRIM, '-i', source, '-i', palette, '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, GIF]);
      const bytes = statSync(GIF).size;
      process.stdout.write(`demo.gif at ${width}px / ${fps} fps: ${(bytes / 1024 / 1024).toFixed(2)} MB\n`);
      if (bytes <= GIF_CAP_BYTES) break;
    }
    const gifBytes = statSync(GIF).size;
    if (gifBytes > GIF_CAP_BYTES) throw new Error(`demo.gif is ${gifBytes} bytes, over the ${GIF_CAP_BYTES} cap`);
    process.stdout.write(`wrote ${GIF} (${(gifBytes / 1024 / 1024).toFixed(2)} MB) and ${MP4} (${(statSync(MP4).size / 1024 / 1024).toFixed(2)} MB)\n`);
  } finally {
    // Let the server release the database before its home is removed; Windows refuses the delete otherwise.
    const exited = new Promise<void>((r) => server.once('exit', () => r()));
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    for (const dir of [home, videoDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
