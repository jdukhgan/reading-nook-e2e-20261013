import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateBookInput, parseBookId, apiError, SERVER_MESSAGES, MAX_BODY_BYTES, BOOK_FIELDS } from './web/contract.js';

const root = dirname(fileURLToPath(import.meta.url));
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };
// Explicit allowlist: repository metadata, fixtures and runtime data are never public.
const publicFiles = new Set(['index.html', 'app.js', 'ui.js', 'contract.js', 'styles.css',
  'fonts/newsreader-latin-opsz-normal.woff2', 'fonts/newsreader-latin-ext-opsz-normal.woff2',
  'fonts/newsreader-latin-opsz-italic.woff2', 'fonts/newsreader-latin-ext-opsz-italic.woff2',
  'fonts/instrument-sans-latin-wght-normal.woff2', 'fonts/instrument-sans-latin-ext-wght-normal.woff2',
  'fonts/OFL-Newsreader.txt', 'fonts/OFL-InstrumentSans.txt']);

class HttpError extends Error {
  constructor(status, code, message, fields) { super(message); this.status = status; this.body = apiError(code, message, fields); }
}
function validation(message, fields) { return new HttpError(400, 'validation', message, fields); }
async function readJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'validation', 'Send this request as JSON.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw validation(SERVER_MESSAGES.too_large);
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks))); }
  catch { throw validation(SERVER_MESSAGES.bad_json); }
}

export function createApp({ dbPath = ':memory:', logger = console.error } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), {recursive:true,mode:0o700});
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, author TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('want_to_read','reading','finished'))
    );
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  function transaction(run) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = run(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  transaction(() => {
    if (db.prepare("SELECT value FROM metadata WHERE key='seeded'").get()) return;
    const seed = JSON.parse(readFileSync(resolve(root, 'fixtures/books.json'), 'utf8')).books;
    const insert = db.prepare('INSERT INTO books (id,title,author,notes,status) VALUES (?,?,?,?,?)');
    for (const book of seed) {
      const {id, ...fields} = book;
      const check = validateBookInput(fields);
      if (!parseBookId(id) || !check.ok) throw new Error('Invalid seed fixture');
      insert.run(id, check.value.title, check.value.author, check.value.notes, check.value.status);
    }
    db.prepare("INSERT INTO metadata VALUES ('seeded','1')").run();
  });
  const getBook = db.prepare('SELECT id,title,author,notes,status FROM books WHERE id=?');
  function requireBook(id) {
    const book = getBook.get(id);
    if (!book) throw new HttpError(404, 'not_found', SERVER_MESSAGES.not_found);
    return book;
  }
  function json(res, status, body) {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/health' && req.method === 'GET') { db.prepare('SELECT 1').get(); json(res, 200, {status:'ok'}); return; }
      if (path === '/api/books' || path.startsWith('/api/books/')) {
        if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
          // The app has no cross-origin API. Origin and Fetch Metadata protect the private shelf.
          const origin = req.headers.origin;
          if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== `http://${req.headers.host}`)) throw new HttpError(403, 'validation', 'Use Reading Nook from its own address.');
        }
        if (path === '/api/books' && req.method === 'GET') { json(res, 200, {books:db.prepare('SELECT id,title,author,notes,status FROM books ORDER BY id').all()}); return; }
        const rawId = path === '/api/books' ? null : path.slice('/api/books/'.length);
        const id = rawId === null ? null : parseBookId(rawId);
        if (rawId !== null && id === null) throw validation(SERVER_MESSAGES.invalid_id);
        if ((rawId === null && req.method === 'POST') || (id !== null && req.method === 'PATCH')) {
          const partial = req.method === 'PATCH';
          const check = validateBookInput(await readJSON(req), {partial});
          if (!check.ok) throw validation(SERVER_MESSAGES.validation, check.fields);
          const book = transaction(() => {
            if (!partial) {
              const {title, author, notes, status} = check.value;
              const result = db.prepare('INSERT INTO books (title,author,notes,status) VALUES (?,?,?,?)').run(title,author,notes,status);
              return getBook.get(Number(result.lastInsertRowid));
            }
            requireBook(id);
            // Column names come only from the shared allowlist, never the request.
            const keys = BOOK_FIELDS.filter(key => Object.hasOwn(check.value, key));
            db.prepare(`UPDATE books SET ${keys.map(key => `${key}=?`).join(',')} WHERE id=?`).run(...keys.map(key => check.value[key]), id);
            return getBook.get(id);
          });
          json(res, partial ? 200 : 201, {book}); return;
        }
        if (id !== null && req.method === 'DELETE') {
          transaction(() => { requireBook(id); db.prepare('DELETE FROM books WHERE id=?').run(id); });
          json(res, 204); return;
        }
        throw new HttpError(405, 'validation', 'That action is not supported.');
      }
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (!['GET','HEAD'].includes(req.method) || !publicFiles.has(file)) { json(res,404,apiError('not_found','That page does not exist.')); return; }
      const content = readFileSync(resolve(root,'web',file));
      res.writeHead(200, {'Content-Type':mime[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-cache',
        'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) json(res, error.status, error.body);
      else { logger('Reading Nook request failed', error); json(res, 500, apiError('internal', SERVER_MESSAGES.internal)); }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, close: () => db.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values} = parseArgs({options:{host:{type:'string',default:'127.0.0.1'},port:{type:'string',default:'8767'},db:{type:'string',default:resolve(root,'.kandev/runtime/reading-nook.sqlite')}}});
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535');
  process.umask(0o077);
  const app = createApp({dbPath:values.db});
  app.server.listen(port,values.host,() => console.log(`Reading Nook ready at http://${values.host}:${port}/`));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => app.server.close(() => {app.close();process.exit(0);}));
}
