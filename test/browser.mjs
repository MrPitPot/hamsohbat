// Launches a headless Chromium for the browser tests: the installed Chrome or Edge, or the Chromium at
// CHROMIUM_PATH (or /opt/pw-browsers/chromium, as preinstalled in the cloud container). Returns null if none.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

export async function launchBrowser(args) {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch {}
  }
  for (const executablePath of [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium']) {
    if (!executablePath || !existsSync(executablePath)) continue;
    try {
      return await chromium.launch({ executablePath, headless: true, args });
    } catch {}
  }
  return null;
}
