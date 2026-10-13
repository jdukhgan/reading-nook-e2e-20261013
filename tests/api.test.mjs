import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { DatabaseSync } from 'node:sqlite';

async function start(dbPath) {
  const app = createApp({ dbPath, logger: () => {} });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, async stop() { await new Promise((resolve) => app.server.close(resolve)); app.close(); } };
}
async function request(app, path = '/api/books', method = 'GET', value) {
  const response = await fetch(app.base + path, { method, headers: value === undefined ? {} : { 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

test('CRUD commits, preserves normalized Unicode, and seed runs only once across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nook-api-'));
  let app;
  try {
    const dbPath = join(dir, 'shelf.sqlite');
    app = await start(dbPath);
    const seed = (await request(app)).body.books;
    assert.equal(seed.length, 6);
    assert.equal(seed[0].title, 'The Orchard at Dusk');
    const created = await request(app, '/api/books', 'POST', { title: '  A 🌿 shelf  ', author: '  Writer  ', notes: '  first\n  second  ' });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.book, { id: 7, title: 'A 🌿 shelf', author: 'Writer', notes: 'first\n  second', status: 'want_to_read' });
    const id = created.body.book.id;
    const patched = await request(app, `/api/books/${id}`, 'PATCH', { status: 'reading', title: '<img src=x onerror=alert(1)>' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.book.status, 'reading');
    await app.stop(); app = await start(dbPath);
    assert.deepEqual((await request(app)).body.books.at(-1), patched.body.book);
    for (const book of (await request(app)).body.books) assert.equal((await request(app, `/api/books/${book.id}`, 'DELETE')).status, 204);
    await app.stop(); app = await start(dbPath);
    assert.deepEqual((await request(app)).body.books, []);
    const fresh = await request(app, '/api/books', 'POST', { title: 'New', author: 'Reader' });
    assert.equal(fresh.body.book.id, 8);
  } finally { if (app) await app.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('invalid payloads/IDs/JSON never alter existing records; Unicode limits count code points', async () => {
  const app = await start(':memory:');
  try {
    const before = (await request(app)).body;
    for (const payload of [null, [], {}, {title:' ',author:'A'}, {title:'T',author:null}, {title:'T',author:'A',status:'unknown'}, {title:'T',author:'A',id:99}, JSON.parse('{"title":"T","author":"A","__proto__":"invalid"}'), {title:'T',author:'A',constructor:'invalid'}, {title:'T\u0000',author:'A'}, {title:'T',author:'A\nB'}, {title:'\ud800',author:'A'}, {title:'🌿'.repeat(161),author:'A'}, {title:'T',author:'A'.repeat(121)}, {title:'T',author:'A',notes:'🌿'.repeat(1001)}]) {
      const result = await request(app, '/api/books', 'POST', payload);
      assert.equal(result.status, 400, JSON.stringify(payload));
      assert.equal(result.body.error.code, 'validation');
    }
    for (const id of ['0', '01', '-1', '1.0', '1e3', '9007199254740992', '%27OR%201=1']) {
      assert.equal((await request(app, `/api/books/${id}`, 'PATCH', {status:'reading'})).status, 400);
      assert.equal((await request(app, `/api/books/${id}`, 'DELETE')).status, 400);
    }
    assert.equal((await request(app, '/api/books/999', 'PATCH', {status:'reading'})).status, 404);
    assert.equal((await request(app, '/api/books/999', 'DELETE')).status, 404);
    assert.equal((await request(app, '/api/books/1', 'PATCH', {})).status, 400);
    for (const body of ['{bad', ' '.repeat(16385), '{"title":"x","author":"y"' ]) {
      const response = await fetch(app.base + '/api/books', {method:'POST',headers:{'Content-Type':'application/json'},body});
      assert.equal(response.status, 400);
    }
    const invalidUtf8 = await fetch(app.base + '/api/books', {method:'POST',headers:{'Content-Type':'application/json'},body:Buffer.from([0x7b,0x22,0x74,0x69,0x74,0x6c,0x65,0x22,0x3a,0x22,0xff,0x22,0x7d])});
    assert.equal(invalidUtf8.status, 400);
    const wrongType = await fetch(app.base + '/api/books', { method:'POST', body:'{}' });
    assert.equal(wrongType.status, 415);
    assert.deepEqual((await request(app)).body, before);
    const max = await request(app, '/api/books', 'POST', {title:'🌿'.repeat(160),author:'a'.repeat(120),notes:'🌿'.repeat(1000)});
    assert.equal(max.status, 201);
  } finally { await app.stop(); }
});

test('SQLite failure rolls back and returns only safe error copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nook-failure-'));
  const dbPath = join(dir, 'shelf.sqlite');
  const app = await start(dbPath);
  const inspector = new DatabaseSync(dbPath);
  try {
    const before = (await request(app)).body;
    inspector.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON books BEGIN SELECT RAISE(ABORT, 'private SQL/path details'); END");
    const result = await request(app, '/api/books/1', 'PATCH', {title:'Changed'});
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, 'internal');
    assert.ok(!JSON.stringify(result.body).includes('private'));
    assert.deepEqual((await request(app)).body, before);
    inspector.exec('DROP TRIGGER reject_update');
    assert.equal((await request(app, '/api/books/1', 'PATCH', {title:'Changed'})).status, 200);
  } finally { inspector.close(); await app.stop(); await rm(dir, {recursive:true,force:true}); }
});

test('serves only production public assets; API rejects cross-origin mutations', async () => {
  const app = await start(':memory:');
  try {
    for (const path of ['/', '/app.js', '/ui.js', '/styles.css', '/fonts/newsreader-latin-opsz-normal.woff2']) assert.equal((await fetch(app.base + path)).status, 200, path);
    for (const path of ['/server.mjs', '/.git/config', '/.kandev/jlab-project.json', '/fixtures/books.json', '/demo.js', '/demo.html', '/%2e%2e/server.mjs']) assert.equal((await fetch(app.base + path)).status, 404, path);
    const response = await fetch(app.base + '/api/books', {method:'POST',headers:{'Content-Type':'application/json',Origin:'https://hostile.invalid'},body:'{"title":"X","author":"Y"}'});
    assert.equal(response.status, 403);
    assert.equal((await request(app)).body.books.length, 6);
    assert.equal((await fetch(app.base + '/health')).status, 200);
  } finally { await app.stop(); }
});
