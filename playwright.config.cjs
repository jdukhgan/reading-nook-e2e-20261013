module.exports = {
  testDir: './tests/browser',
  timeout: 20000,
  use: { browserName: 'chromium', headless: true, viewport: {width:1440,height:900}, reducedMotion:'no-preference', trace:'retain-on-failure' },
};
