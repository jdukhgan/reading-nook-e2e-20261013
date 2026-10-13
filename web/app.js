import { createReadingNook } from './ui.js';

let books = [];
let loaded = false;
let loadPromise;
async function request(path, method = 'GET', fields) {
  const response = await fetch(path, {
    method,
    headers: fields === undefined ? {} : { 'Content-Type': 'application/json' },
    body: fields === undefined ? undefined : JSON.stringify(fields),
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw body;
  return body;
}
// Commit responses are the authoritative state. No follow-up GET gates a saved action.
function acceptBook(book) {
  const existing = books.some(item => item.id === book.id);
  books = existing ? books.map(item => item.id === book.id ? book : item) : [...books, book];
  ui.setBooks(books);
  return book;
}
async function update(id, patch) {
  await ensureLoaded();
  const {book} = await request(`/api/books/${id}`, 'PATCH', patch);
  return acceptBook(book);
}
const ui = createReadingNook(document.getElementById('app'), {
  async onCreate(fields) { await ensureLoaded(); return acceptBook((await request('/api/books', 'POST', fields)).book); },
  onUpdate: update,
  onStatusChange: (id, status) => update(id, {status}),
  async onDelete(id) {
    await ensureLoaded();
    await request(`/api/books/${id}`, 'DELETE');
    books = books.filter(book => book.id !== id);
    ui.setBooks(books);
  },
  onRetryLoad: () => load().catch(() => {}),
});
// Serialize the first shelf read with writes. A delayed snapshot must not replace
// newly committed data, and a failed read must not turn a partial list into the shelf.
function ensureLoaded() { return loaded ? Promise.resolve() : load(); }
function load() {
  if (loadPromise) return loadPromise;
  ui.setLoading();
  loadPromise = (async () => {
    try {
      books = (await request('/api/books')).books;
      loaded = true;
      ui.setBooks(books);
    } catch (error) {
      ui.setLoadError(error);
      throw error;
    } finally { loadPromise = null; }
  })();
  return loadPromise;
}
load().catch(() => {});
