'use strict';
/**
 * The runner.
 *
 * Headed by default, and single-worker. Both are deliberate: client and AP
 * sign-in pause for a person to type a real six-digit code into the real window,
 * so there has to be a window, and two tests racing for it would be unusable.
 * Once the app has an admin allow-list of static test codes, set HEADLESS=1 and
 * raise the workers.
 *
 * The workbook is read here rather than in each spec so that a missing or
 * malformed plan fails once, before a browser is launched, with a message that
 * says what to do about it.
 */
const { defineConfig } = require('@playwright/test');
const path = require('path');

// Read synchronously at config time: defineConfig cannot await, and every spec
// needs the environment before it can do anything at all.
const book = require('./lib/bookSync').loadSync();

process.env.OFS_QA_ENV_NAME = book.envName;
process.env.OFS_QA_BASE_URL = book.env.base_url;

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const out = path.join(__dirname, 'results',
  'OFS_Test_Results_' + book.envName + '_' + stamp + '.xlsx');

module.exports = defineConfig({
  testDir: './specs',
  // A UI test that needs thirty seconds is usually a test waiting for something
  // that is never going to happen, except the OTP pause, which manages its own.
  timeout: 45 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false,
  workers: 1,
  // Never on production. A retry re-runs the whole test, and a test that placed
  // a bid before it failed would place a second one.
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'results/html', open: 'never' }],
    [path.join(__dirname, 'lib', 'xlsx-reporter.js'), { outputFile: out }]
  ],
  use: {
    headless: process.env.HEADLESS === '1',
    baseURL: book.env.base_url,
    viewport: { width: 1440, height: 900 },
    // Evidence only when something went wrong: a screenshot of every passing
    // render test is four hundred files nobody opens.
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15 * 1000,
    ignoreHTTPSErrors: true
  },
  outputDir: 'results/artifacts',
  projects: [
    { name: 'desk', testMatch: /.*\/(render|flows)\/backoffice\..*\.spec\.js/ },
    { name: 'ap', testMatch: /.*\/(render|flows)\/partner\..*\.spec\.js/ },
    { name: 'client', testMatch: /.*\/(render|flows)\/client\..*\.spec\.js/ }
  ]
});
