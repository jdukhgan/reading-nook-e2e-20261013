// Shared assertions for a project's existing Playwright harness. No new runtime.
const fs = require('node:fs');
const path = require('node:path');

async function assertVisualState(page, {theme, viewport, themeSelector = 'html', themeAttribute = 'class', themeValue = theme}) {
  if (!theme || !viewport?.width || !viewport?.height) throw new Error('Theme and expected viewport are required');
  await page.evaluate(() => document.fonts.ready);
  const rendered = await page.evaluate(({themeSelector, themeAttribute, themeValue}) => {
    const root = document.querySelector(themeSelector);
    const value = root?.getAttribute(themeAttribute) || '';
    return {
      themeMatched: themeAttribute === 'class' ? value.split(/\s+/).includes(themeValue) : value === themeValue,
      themeAttributeValue: value,
      background: root ? getComputedStyle(root).backgroundColor : null,
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      viewport: {width: innerWidth, height: innerHeight},
    };
  }, {themeSelector, themeAttribute, themeValue});
  if (rendered.viewport.width !== viewport.width || rendered.viewport.height !== viewport.height)
    throw new Error(`Viewport ${JSON.stringify(rendered.viewport)} differs from requested ${JSON.stringify(viewport)}`);
  if (!rendered.themeMatched) throw new Error(`Rendered theme ${JSON.stringify(rendered.themeAttributeValue)} does not match ${JSON.stringify(themeValue)}`);
  if (rendered.documentWidth > viewport.width)
    throw new Error(`Document overflow: ${rendered.documentWidth}px exceeds ${viewport.width}px viewport`);
  return rendered;
}

async function captureEvidence(page, options) {
  if (!options.path || !options.revision || typeof options.dirty !== 'boolean')
    throw new Error('Capture path, source revision and dirty state are required');
  // A failed replacement must not leave an earlier passing receipt at this path.
  fs.rmSync(options.path + '.json', {force: true});
  fs.rmSync(options.path, {force: true});
  const rendered = await assertVisualState(page, options);
  fs.mkdirSync(path.dirname(options.path), {recursive: true});
  await page.screenshot({path: options.path, fullPage: true});
  const receipt = {revision: options.revision, dirty: options.dirty,
    requestedTheme: options.theme, viewport: rendered.viewport, rendered};
  fs.writeFileSync(options.path + '.json', JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
module.exports = {assertVisualState, captureEvidence};
