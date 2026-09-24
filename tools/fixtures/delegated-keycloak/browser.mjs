import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

export async function localBrowser(headless = true) {
  const directory = path.join(import.meta.dirname, '.private', 'browser-runtime');
  await mkdir(directory, { recursive: true });
  process.env.TEMP = directory;
  process.env.TMP = directory;
  process.env.TMPDIR = directory;
  return chromium.launch({ channel: 'msedge', headless, downloadsPath: directory, tracesDir: directory });
}

export async function enterCredentials(page, user) {
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();
}

export async function browserAuthorization(browser, oauth, user) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const transaction = await oauth.begin();
    let capture;
    const captured = new Promise((resolve) => { capture = resolve; });
    await page.route((url) => url.origin === 'http://127.0.0.1:18880' && url.pathname.endsWith('/login-actions/authenticate'), async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers().location;
      if (location && new URL(location).origin === 'http://127.0.0.1:18881') {
        await route.fulfill({ status: 200, contentType: 'text/plain', body: 'Local authorization captured in memory.' });
        capture(location);
      } else {
        await route.fulfill({ response });
      }
    });
    await page.goto(transaction.url.href);
    await enterCredentials(page, user);
    await page.getByText('Local authorization captured in memory.', { exact: true }).waitFor();
    const callback = await captured;
    return { callback, transaction };
  } finally {
    await context.close();
  }
}
