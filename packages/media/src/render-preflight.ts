import { createServer } from 'node:http';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { within, invariant } from '../../core/src/util.js';

export async function preflight(directory: string) {
  const root = await realpath(directory);
  const server = createServer(async (request, response) => {
    try {
      const name = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const file = await realpath(path.join(root, name === '/' ? 'index.html' : name.slice(1)));
      if (!within(root, file)) throw new Error('Out of project');
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
      };
      if (!mime[path.extname(file)]) throw new Error('Not a render asset');
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Content-Length': content.length });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const address = server.address();
    invariant(address && typeof address !== 'string', 'PREFLIGHT_SERVER', 'Cannot bind preflight server');
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: 'shell',
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-breakpad',
        '--disable-background-networking',
      ],
    });
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(String(error)));
    page.on('requestfailed', (request) => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.url()}: HTTP ${response.status()}`);
    });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname === '127.0.0.1' && url.port === String(address.port)) void request.continue();
      else void request.abort();
    });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
    try {
      // Headless shell does not necessarily drive requestAnimationFrame until a capture starts.
      await page.waitForFunction('Boolean(window.__timelines && window.__timelines.main)', {
        timeout: 10000,
        polling: 100,
      });
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        html: document.documentElement.outerHTML.slice(0, 600),
        state: document.readyState,
        fonts: document.fonts.status,
        timelines: Object.keys((window as unknown as { __timelines?: object }).__timelines ?? {}),
      }));
      throw new Error(
        `Render page initialization failed: ${JSON.stringify(diagnostic)}; ${failures.join('; ')}`,
        { cause: error },
      );
    }
    const result = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('[data-composition-id]')!;
      const width = Number(root.dataset.width),
        height = Number(root.dataset.height);
      const issues: { id: string; issue: string }[] = [];
      for (const element of document.querySelectorAll<HTMLElement>('.measured-text')) {
        if (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1)
          issues.push({ id: element.id, issue: 'text_overflow' });
        const box = element.getBoundingClientRect();
        if (box.x < 0 || box.y < 0 || box.right > width + 1 || box.bottom > height + 1)
          issues.push({ id: element.id, issue: 'text_outside_canvas' });
      }
      return { issues, width, height, fonts: document.fonts.status };
    });
    await writeFile(path.join(directory, 'preflight.json'), JSON.stringify(result, null, 2));
    invariant(
      result.issues.length === 0,
      'LAYOUT_OVERFLOW',
      `LAYOUT_OVERFLOW: ${JSON.stringify(result.issues)}`,
    );
    return result;
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
