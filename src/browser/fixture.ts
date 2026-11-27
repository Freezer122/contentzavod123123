import { chromium } from 'playwright';
import { AdsPowerProvider } from './providers.js';
// Fixtures get fresh incognito contexts, never the authenticated profile context.
export async function fixtureBrowser() {
  if (process.env.ADSPOWER_FIXTURES !== '1') {
    const browser = await chromium.launch({ headless: true });
    return { browser, close: () => browser.close() };
  }
  const id = 'k1j71gt4';
  const provider = new AdsPowerProvider(
    'http://127.0.0.1:50325',
    process.env.ADSPOWER_API_KEY,
    undefined,
    [id],
    true,
  );
  if (await provider.status(id)) throw new Error('Fixture browser requires an idle profile');
  const session = await provider.start(id);
  try {
    const browser = await chromium.connectOverCDP(session.cdpEndpoint);
    return {
      browser,
      close: async () => {
        await provider.stop(id);
        await browser.close().catch(() => {});
      },
    };
  } catch (e) {
    await provider.stop(id);
    throw e;
  }
}
