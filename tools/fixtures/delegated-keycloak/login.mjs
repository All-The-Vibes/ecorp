import { readFile } from 'node:fs/promises';
import { localBrowser, enterCredentials } from './browser.mjs';

const config = JSON.parse(await readFile(new URL('.private/config.json', import.meta.url), 'utf8'));
const browser = await localBrowser(false);
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:18881/login');
  await enterCredentials(page, config.reader);
  await page.waitForURL('http://127.0.0.1:18881/result');
  console.log('Local synthetic login finished. Close the isolated Edge window when done.');
  await new Promise((resolve) => browser.on('disconnected', resolve));
} finally { await browser.close(); }
