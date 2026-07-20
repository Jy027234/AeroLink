#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';
import { chromium } from '@playwright/test';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith('--')) continue;
  const key = value.slice(2);
  const next = process.argv[index + 1];
  args.set(key, next && !next.startsWith('--') ? next : 'true');
  if (next && !next.startsWith('--')) index += 1;
}

const baselineUrl = args.get('baseline-url') ?? process.env.P2_BASELINE_URL;
const currentUrl = args.get('current-url') ?? process.env.P2_CURRENT_URL;
const email = args.get('email') ?? process.env.E2E_EMAIL ?? 'zhang@aerolink.com';
const password = args.get('password') ?? process.env.E2E_PASSWORD;
const path = args.get('path') ?? '/dashboard';
const runs = Number(args.get('runs') ?? '3');
const settleMs = Number(args.get('settle-ms') ?? '500');
const outputPath = args.get('output') ?? 'docs/p2-runtime-baseline-2026-07-20.json';

if (!baselineUrl || !currentUrl || !password) {
  throw new Error('Usage: --baseline-url <url> --current-url <url> --password <seed-password> [--path /dashboard] [--runs 3]');
}
if (!Number.isInteger(runs) || runs < 2 || runs > 10) {
  throw new Error('--runs must be an integer between 2 and 10');
}
if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 5000) {
  throw new Error('--settle-ms must be an integer between 0 and 5000');
}

const normalizedPath = path.startsWith('/') ? path : `/${path}`;

async function measure(label, baseURL) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const measurements = [];

  try {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    try {
      await page.locator('main').waitFor({ state: 'visible', timeout: 15_000 });
    } catch (error) {
      const failure = {
        url: page.url(),
        bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 1000),
        storageKeys: await page.evaluate(() => Object.keys(localStorage)).catch(() => []),
      };
      throw new Error(`${label} login did not reach main: ${JSON.stringify(failure)}; ${error.message}`);
    }

    for (let run = 1; run <= runs; run += 1) {
      const requests = [];
      const apiRequests = [];
      const requestStartedAt = new Map();
      const onRequest = (request) => {
        const requestUrl = new URL(request.url());
        requestStartedAt.set(request, Date.now());
        if (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') {
          if (requestUrl.pathname !== '/favicon.ico') requests.push({ method: request.method(), url: requestUrl.pathname });
        }
      };
      const onResponse = (response) => {
        const responseUrl = new URL(response.url());
        const startedAt = requestStartedAt.get(response.request());
        if (startedAt && responseUrl.pathname.startsWith('/api/')) {
          apiRequests.push({
            method: response.request().method(),
            url: responseUrl.pathname,
            status: response.status(),
            durationMs: Date.now() - startedAt,
          });
        }
      };
      page.on('request', onRequest);
      page.on('response', onResponse);
      const startedAt = Date.now();
      await page.goto(new URL(normalizedPath, baseURL).toString(), { waitUntil: 'domcontentloaded' });
      await page.locator('main').waitFor({ state: 'visible' });
      const timing = await page.evaluate(() => {
        const paint = performance.getEntriesByName('first-contentful-paint')[0];
        const navigation = performance.getEntriesByType('navigation')[0];
        return {
          fcpMs: paint ? Math.round(paint.startTime * 100) / 100 : null,
          domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd * 100) / 100 : null,
          loadEventMs: navigation ? Math.round(navigation.loadEventEnd * 100) / 100 : null,
          firstUsableContentMs: Math.round(performance.now() * 100) / 100,
        };
      });
      await page.waitForTimeout(settleMs);
      page.off('request', onRequest);
      page.off('response', onResponse);
      measurements.push({
        run,
        requestCount: requests.length,
        requests,
        apiRequestCount: apiRequests.length,
        apiRequests,
        wallClockMs: Date.now() - startedAt,
        ...timing,
      });
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const warmRuns = measurements.slice(1);
  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const percentile = (values, percentileRank) => {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileRank) - 1);
    return sorted[index];
  };
  const numeric = (key) => warmRuns.map((entry) => entry[key]).filter((value) => typeof value === 'number');
  const apiDurations = warmRuns.flatMap((entry) => entry.apiRequests.map((request) => request.durationMs));
  return {
    label,
    baseURL,
    path: normalizedPath,
    runs: measurements,
    warmMedian: {
      requestCount: median(numeric('requestCount')),
      apiRequestCount: median(numeric('apiRequestCount')),
      apiP50Ms: percentile(apiDurations, 0.5),
      apiP95Ms: percentile(apiDurations, 0.95),
      fcpMs: numeric('fcpMs').length ? median(numeric('fcpMs')) : null,
      firstUsableContentMs: median(numeric('firstUsableContentMs')),
      domContentLoadedMs: median(numeric('domContentLoadedMs')),
      loadEventMs: median(numeric('loadEventMs')),
      wallClockMs: median(numeric('wallClockMs')),
    },
  };
}

const startedAt = new Date().toISOString();
const results = {
  schemaVersion: 1,
  measuredAt: startedAt,
  environment: {
    node: process.version,
    browser: 'Playwright Chromium (headless)',
    viewport: '1440x900',
    runs,
    settleMs,
    path: normalizedPath,
    passwordSource: 'E2E_PASSWORD environment variable (not persisted)',
  },
  baseline: await measure('baseline', baselineUrl),
  current: await measure('current', currentUrl),
};

const parent = outputPath.slice(0, outputPath.lastIndexOf('/'));
if (parent) await fs.mkdir(parent, { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: outputPath, baseline: results.baseline.warmMedian, current: results.current.warmMedian }, null, 2));
