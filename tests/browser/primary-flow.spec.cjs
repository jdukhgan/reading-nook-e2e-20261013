const {test, expect} = require('@playwright/test');
const {mkdtempSync, rmSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {execFileSync} = require('node:child_process');
const {captureEvidence} = require('./evidence.cjs');
let app, db, dir, base;
test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nook-browser-'));
  const {createApp} = await import('../../server.mjs');
  app = createApp({dbPath:join(dir,'test.sqlite'),logger:()=>{}});
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  db = new DatabaseSync(join(dir,'test.sqlite'));
});
test.afterEach(async ({page}) => {
  await page.close();
  db.close();
  const closed = new Promise(resolve => app.server.close(resolve));
  app.server.closeAllConnections();
  await closed;
  app.close();
  rmSync(dir,{recursive:true,force:true});
});
const row = (page,id=1) => page.locator(`.book[data-id="${id}"]`);
async function open(page) {
  await page.goto(base);
  await expect(row(page)).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
}
async function record(page,name,theme='light') {
  const expectedBackground = theme === 'dark' ? 'rgb(27, 23, 20)' : 'rgb(245, 239, 227)';
  await expect(page.locator('html')).toHaveCSS('background-color', expectedBackground);
  // The app uses CSS media queries. Record the observed theme after checking its actual paint.
  await page.evaluate(theme => document.documentElement.setAttribute('data-observed-theme',theme),theme);
  const revision = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const dirty = Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());
  await captureEvidence(page,{
    path:resolve(`.kandev/integration-evidence/${name}.png`),revision,dirty,
    theme,viewport:page.viewportSize(),themeSelector:'html',themeAttribute:'data-observed-theme',themeValue:theme,
  });
}

test('CRUD uses committed responses without a refresh, search/filter and literal text survive reload', async ({page}) => {
  await open(page);
  await page.getByRole('button',{name:'Add book',exact:true}).click();
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('<img src=x onerror=alert(1)> 🌿');
  await page.getByRole('textbox',{name:'Author',exact:true}).fill('A Reader');
  await page.getByRole('textbox',{name:'Notes',exact:true}).fill('first\nsecond');
  // All later GETs fail: mutation success must still be final and update local state.
  let followupGets = 0;
  await page.route('**/api/books',route => {
    if (route.request().method()==='GET') { followupGets++; return route.fulfill({status:500,json:{error:{code:'internal'}}}); }
    return route.continue();
  });
  await page.getByRole('button',{name:'Add to shelf',exact:true}).click();
  await expect(row(page,7)).toContainText('<img src=x onerror=alert(1)> 🌿');
  await expect(row(page,7).locator('img')).toHaveCount(0);
  await row(page,7).getByRole('button',{name:'Edit',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('<img src=x onerror=alert(1)> 🌿');
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('A quiet shelf');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(row(page,7)).toContainText('A quiet shelf');
  expect(followupGets).toBe(0);
  await page.getByRole('searchbox',{name:'Search your shelf'}).fill('A READER');
  await expect(page.locator('.book:visible')).toHaveCount(1);
  await row(page,7).getByRole('combobox').selectOption('reading');
  await expect(row(page,7).getByRole('combobox')).toHaveValue('reading');
  await page.getByRole('button',{name:/^Finished/}).click();
  await expect(page.getByText('Nothing on this shelf matches')).toBeVisible();
  await page.getByRole('button',{name:'Show all books'}).click();
  await page.unroute('**/api/books');
  await page.reload();
  await expect(row(page,7)).toContainText('A quiet shelf');
  await expect(row(page,7).getByRole('combobox')).toHaveValue('reading');
  await row(page,7).getByRole('button',{name:'Delete',exact:true}).click();
  await row(page,7).getByRole('button',{name:'Remove',exact:true}).click();
  await expect(row(page,7)).toHaveCount(0);
  await expect(row(page,6).getByRole('button',{name:'Edit',exact:true})).toBeFocused();
});

test('real SQLite edit failure retains draft/list, retry keeps focus and pending geometry', async ({page}) => {
  await open(page);
  db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON books BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  await row(page).getByRole('button',{name:'Edit',exact:true}).click();
  const title = page.getByRole('textbox',{name:'Title',exact:true});
  await title.fill('The Orchard, revisited');
  await page.getByRole('textbox',{name:'Notes',exact:true}).fill('Keep this draft\nAnd this line');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  const retry = row(page).locator('[data-action=retry-editor]');
  await expect(retry).toBeFocused();
  await expect(title).toHaveValue('The Orchard, revisited');
  await expect(page.locator('.book')).toHaveCount(6);
  await expect(row(page)).toContainText('Your text is still here.');
  expect(db.prepare('SELECT title FROM books WHERE id=1').get().title).toBe('The Orchard at Dusk');
  await expect(page.getByRole('button',{name:'Add book',exact:true})).not.toHaveAttribute('aria-disabled','true');
  await record(page,'edit-failure-desktop');
  db.exec('DROP TRIGGER reject_update');
  let release;
  const held = new Promise(resolve => {release=resolve;});
  await page.route('**/api/books/1',async route => {await held;await route.continue();});
  const before = await row(page).boundingBox();
  const handle = await row(page).elementHandle();
  await retry.click();
  await expect(retry).toHaveText(/Trying/);
  await expect(retry).toBeFocused();
  await expect(title).toHaveAttribute('readonly','');
  const after = await row(page).boundingBox();
  expect(after.height).toBeCloseTo(before.height,0);
  expect(await handle.evaluate(el=>el.isConnected)).toBe(true);
  await expect(page.getByRole('button',{name:'Add book',exact:true})).toHaveAttribute('aria-disabled','true');
  await expect(page.locator('.shelf-head__pending')).toContainText('Other changes wait until it finishes.');
  release();
  await expect(row(page).getByRole('button',{name:'Edit',exact:true})).toBeFocused();
  await expect(row(page).locator('.book__title')).toHaveText('The Orchard, revisited');
  expect(db.prepare('SELECT notes FROM books WHERE id=1').get().notes).toBe('Keep this draft\nAnd this line');
  await record(page,'integrated-desktop');
});

test('status failure/retry holds DOM, scroll and focus through pending; filtered success uses fallback', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await open(page);
  const select = row(page,6).getByRole('combobox');
  await select.scrollIntoViewIfNeeded();
  await select.focus();
  const handle = await row(page,6).elementHandle();
  db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON books BEGIN SELECT RAISE(ABORT, 'failure'); END");
  await select.selectOption('reading');
  const retry = row(page,6).locator('[data-action=retry-entry]');
  await expect(retry).toBeFocused();
  await expect(select).toHaveValue('finished');
  db.exec('DROP TRIGGER reject_update');
  let release;
  const held = new Promise(resolve=>{release=resolve;});
  await page.route('**/api/books/6',async route=>{await held;await route.continue();});
  const y = await page.evaluate(()=>scrollY);
  const geometry = await page.evaluate(()=>({y:scrollY,h:document.documentElement.scrollHeight,head:document.querySelector('.shelf-head').getBoundingClientRect().height}));
  const before = await row(page,6).boundingBox();
  await retry.click();
  await expect(retry).toHaveText(/Trying/);
  await expect(retry).toBeFocused();
  expect((await row(page,6).boundingBox()).height).toBeCloseTo(before.height,0);
  console.log('status geometry',geometry,await page.evaluate(()=>({y:scrollY,h:document.documentElement.scrollHeight,head:document.querySelector('.shelf-head').getBoundingClientRect().height})));
  expect(await page.evaluate(()=>scrollY)).toBeCloseTo(y,0);
  expect(await handle.evaluate(el=>el.isConnected)).toBe(true);
  release();
  await expect(select).toHaveValue('reading');
  await expect(select).toBeFocused();
  const expectedY = await page.evaluate(y=>Math.min(y,document.documentElement.scrollHeight-innerHeight),y);
  expect(await page.evaluate(()=>scrollY)).toBeCloseTo(expectedY,0);
  expect(await handle.evaluate(el=>el.isConnected)).toBe(true);
  await page.unroute('**/api/books/6');
  await page.getByRole('button',{name:/^Reading\s/}).click();
  await select.selectOption('finished');
  await expect(row(page,6)).toBeHidden();
  await expect(row(page,5).getByRole('button',{name:'Edit',exact:true})).toBeFocused();
});

test('network create failure keeps draft; invalid input focus and Escape return are usable',async ({page})=>{
  await open(page);
  await page.getByRole('button',{name:'Add book',exact:true}).click();
  await page.getByRole('button',{name:'Add to shelf',exact:true}).click();
  const title = page.getByRole('textbox',{name:'Title',exact:true});
  await expect(title).toBeFocused();
  await title.fill('New book 🌿');
  await page.getByRole('textbox',{name:'Author',exact:true}).fill('Reader');
  await page.route('**/api/books',route=>route.request().method()==='POST'?route.abort():route.continue());
  await page.getByRole('button',{name:'Add to shelf',exact:true}).click();
  await expect(page.getByRole('button',{name:'Try again',exact:true})).toBeFocused();
  await expect(title).toHaveValue('New book 🌿');
  await expect(page.locator('.book-list .book')).toHaveCount(6);
  await page.unroute('**/api/books');
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(row(page,7)).toContainText('New book 🌿');
  await expect(row(page,7).getByRole('button',{name:'Edit',exact:true})).toBeFocused();
  await row(page,7).getByRole('button',{name:'Edit',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(row(page,7).getByRole('button',{name:'Edit',exact:true})).toBeFocused();
});

test('initial load failure retries; empty shelf can recover', async ({page})=>{
  let fail=true;
  await page.route('**/api/books',route=>fail?route.fulfill({status:500,json:{error:{code:'internal'}}}):route.continue());
  await page.goto(base);
  await expect(page.getByText("Your shelf couldn't be loaded.",{exact:true})).toBeVisible();
  fail=false;
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(row(page)).toBeVisible();
  db.exec('DELETE FROM books');
  await page.reload();
  await expect(page.getByText('Your shelf is empty',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Add your first book',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Title',exact:true})).toBeFocused();
});

test('responsive theme checks use realistic integrated content and reduced motion',async ({page})=>{
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await open(page);
  for (const [name,width,height] of [['desktop',1440,900],['tablet',820,1180],['phone',390,844]]) {
    await page.setViewportSize({width,height});
    for (const theme of ['light','dark']) {
      await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
      await page.evaluate(()=>document.fonts.ready);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await record(page,`integrated-${name}-${theme}`,theme);
    }
  }
  expect(errors).toEqual([]);
});


test('delete failure retains books and retry; searching during pending keeps the editor draft', async ({page}) => {
  await open(page);
  db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON books BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  await row(page).getByRole('button',{name:'Delete',exact:true}).click();
  await row(page).getByRole('button',{name:'Remove',exact:true}).click();
  await expect(row(page).getByRole('button',{name:'Try again',exact:true})).toBeFocused();
  await expect(page.locator('.book-list .book')).toHaveCount(6);
  expect(db.prepare('SELECT count(*) AS n FROM books').get().n).toBe(6);
  db.exec('DROP TRIGGER reject_delete');
  await row(page).getByRole('button',{name:'Try again',exact:true}).click();
  await expect(row(page)).toHaveCount(0);
  await expect(row(page,2).getByRole('button',{name:'Edit',exact:true})).toBeFocused();
  await row(page,2).getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('Salt Roads, reread');
  let release;
  const held = new Promise(resolve=>{release=resolve;});
  await page.route('**/api/books/2',async route=>{await held;await route.continue();});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByRole('button',{name:'Saving…',exact:true})).toHaveAttribute('aria-disabled','true');
  await page.getByRole('searchbox',{name:'Search your shelf'}).fill('unmatched words');
  await expect(row(page,2)).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Salt Roads, reread');
  await page.getByRole('button',{name:'Add book',exact:true}).click({force:true});
  await expect(page.locator('.new-slot .book')).toHaveCount(0);
  release();
  await expect(row(page,2)).toBeHidden();
  await expect(page.getByRole('button',{name:'Add book',exact:true})).toBeFocused();
  expect(db.prepare('SELECT title FROM books WHERE id=2').get().title).toBe('Salt Roads, reread');
  await page.getByRole('button',{name:'Show all books'}).click();
  await expect(row(page,2)).toContainText('Salt Roads, reread');
});

test('adding while the initial shelf request is delayed cannot replace loaded records',async ({page})=>{
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  let postCount=0;
  await page.route('**/api/books',async route=>{
    if(route.request().method()==='GET') {
      const response=await route.fetch(); // snapshot of the six records before any create
      await held;
      return route.fulfill({response});
    }
    if(route.request().method()==='POST') postCount++;
    return route.continue();
  });
  await page.goto(base);
  await page.getByRole('button',{name:'Add book',exact:true}).click();
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('Early addition');
  await page.getByRole('textbox',{name:'Author',exact:true}).fill('Reader');
  await page.getByRole('button',{name:'Add to shelf',exact:true}).click();
  await expect(page.getByRole('button',{name:'Adding…',exact:true})).toBeVisible();
  expect(postCount).toBe(0);
  release();
  await expect(page.locator('.book-list .book')).toHaveCount(7);
  await expect(row(page,7)).toContainText('Early addition');
  expect(db.prepare('SELECT count(*) AS n FROM books').get().n).toBe(7);
});

test('real API field rejection unlocks controls before focusing the field and retains entered text',async ({page})=>{
  await open(page);
  await page.getByRole('button',{name:'Add book',exact:true}).click();
  const title=page.getByRole('textbox',{name:'Title',exact:true});
  const author=page.getByRole('textbox',{name:'Author',exact:true});
  await title.fill('A retained draft');
  await author.fill('A Reader');
  await page.route('**/api/books',route=>{
    if(route.request().method()!=='POST') return route.continue();
    const payload=route.request().postDataJSON();
    return route.continue({postData:JSON.stringify({...payload,author:'Invalid\nAuthor'})});
  });
  await page.getByRole('button',{name:'Add to shelf',exact:true}).click();
  await expect(author).toBeFocused();
  await expect(author).not.toHaveAttribute('readonly','');
  await expect(author).toHaveAttribute('aria-invalid','true');
  await expect(author).toHaveValue('A Reader');
  await expect(title).toHaveValue('A retained draft');
  await expect(page.locator('.book-list .book')).toHaveCount(6);
  await expect(page.getByText('Author must be a single line of text.',{exact:true})).toBeVisible();
  await page.unroute('**/api/books');
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(row(page,7)).toContainText('A retained draft');
  await expect(row(page,7).getByRole('button',{name:'Edit',exact:true})).toBeFocused();
});
