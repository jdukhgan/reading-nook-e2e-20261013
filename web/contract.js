// Reading Nook shared contract.
// Single source for field limits, statuses, input policy, API error shapes and
// user-facing copy. Imported by the browser UI (web/ui.js, web/app.js) and by
// the Node server (server.mjs). No DOM or Node-only APIs in this module.

export const STATUSES = Object.freeze(['want_to_read', 'reading', 'finished']);

export const STATUS_LABELS = Object.freeze({
  want_to_read: 'Want to read',
  reading: 'Reading',
  finished: 'Finished',
});

export const DEFAULT_STATUS = 'want_to_read';

// Limits count Unicode code points (Array.from), never UTF-16 code units.
export const LIMITS = Object.freeze({ title: 160, author: 120, notes: 1000 });

export const FIELD_LABELS = Object.freeze({
  title: 'Title',
  author: 'Author',
  notes: 'Notes',
  status: 'Status',
});

export const BOOK_FIELDS = Object.freeze(['title', 'author', 'notes', 'status']);

// Maximum accepted JSON request body; a full book with 1000 four-byte notes
// characters stays well below this.
export const MAX_BODY_BYTES = 16 * 1024;

export const ERROR_CODES = Object.freeze({
  validation: 'validation',
  notFound: 'not_found',
  internal: 'internal',
  network: 'network',
});

export function charCount(value) {
  return Array.from(value).length;
}

// IDs travel in paths as canonical positive decimal safe integers: "7", not "07", "+7", "7.0" or "1e3".
export function parseBookId(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// Title/author: single line, no control characters. Notes: may contain newlines and tabs.
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001F\u007F]/;
const NOTES_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function hasLoneSurrogate(value) {
  return typeof value.isWellFormed === 'function'
    ? !value.isWellFormed()
    : /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

function checkText(field, raw, { required }) {
  if (typeof raw !== 'string') return { error: `${FIELD_LABELS[field]} must be text.` };
  if (raw.includes('\u0000') || hasLoneSurrogate(raw)) {
    return { error: `${FIELD_LABELS[field]} contains characters that can't be saved.` };
  }
  // Trim the ends only; interior whitespace and newlines in notes are preserved.
  const value = raw.trim();
  const forbidden = field === 'notes' ? NOTES_FORBIDDEN : SINGLE_LINE_FORBIDDEN;
  if (forbidden.test(value)) {
    return {
      error: field === 'notes'
        ? 'Notes contain characters that can\'t be saved.'
        : `${FIELD_LABELS[field]} must be a single line of text.`,
    };
  }
  if (required && value.length === 0) {
    return { error: field === 'title' ? 'Add a title.' : 'Add an author.' };
  }
  const count = charCount(value);
  if (count > LIMITS[field]) {
    return { error: `Keep ${FIELD_LABELS[field].toLowerCase()} to ${LIMITS[field]} characters (now ${count}).` };
  }
  return { value };
}

/**
 * Validate a create payload (partial=false) or a PATCH payload (partial=true).
 * Create: title and author required, notes optional (default ""), status optional (default want_to_read).
 * Patch: any non-empty subset of title/author/notes/status.
 * Unknown keys (including id) are rejected.
 * Returns { ok: true, value } with normalized fields, or { ok: false, fields: { field: message } }.
 */
export function validateBookInput(input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, fields: { _: 'Send the book as a JSON object.' } };
  }
  // Collect messages in a Map: plain-object assignment would treat a "__proto__" key as a prototype
  // setter and silently drop it. Object.fromEntries below creates own, JSON-serializable keys.
  const fields = new Map();
  const value = {};
  const has = (key) => Object.hasOwn(input, key);
  for (const key of Object.keys(input)) {
    if (!BOOK_FIELDS.includes(key)) fields.set(key, 'This field is not part of a book.');
  }
  for (const field of ['title', 'author', 'notes']) {
    if (!has(field)) {
      if (!partial && field !== 'notes') fields.set(field, field === 'title' ? 'Add a title.' : 'Add an author.');
      continue;
    }
    const result = checkText(field, input[field], { required: field !== 'notes' });
    if (result.error) fields.set(field, result.error);
    else value[field] = result.value;
  }
  if (has('status')) {
    if (STATUSES.includes(input.status)) value.status = input.status;
    else fields.set('status', 'Choose Want to read, Reading or Finished.');
  }
  if (!partial) {
    if (!has('notes') && !fields.has('notes')) value.notes = '';
    if (!has('status') && !fields.has('status')) value.status = DEFAULT_STATUS;
  } else if (Object.keys(input).length === 0) {
    fields.set('_', 'Nothing to update.');
  }
  return fields.size ? { ok: false, fields: Object.fromEntries(fields) } : { ok: true, value };
}

// API error body: { error: { code, message, fields? } }.
export function apiError(code, message, fields) {
  const error = { code, message };
  if (fields && Object.keys(fields).length) error.fields = fields;
  return { error };
}

export const SERVER_MESSAGES = Object.freeze({
  validation: 'Some details need attention.',
  not_found: 'That book no longer exists.',
  internal: 'Something went wrong on the server. Nothing was changed.',
  invalid_id: 'That book address is not valid.',
  bad_json: 'The request could not be read.',
  too_large: 'The request is too large.',
});

// Normalize anything a controller rejects with into { code, message, fields }.
// Accepts an API body ({error}), a plain {code,message,fields}, a fetch TypeError, or any Error.
export function normalizeError(reason) {
  const body = reason && typeof reason === 'object' && reason.error && typeof reason.error === 'object'
    ? reason.error
    : reason;
  if (body && typeof body === 'object' && typeof body.code === 'string' && Object.hasOwn(FAILURE_COPY, body.code)) {
    return {
      code: body.code,
      // Only validation messages are shown verbatim; other codes use the UI's own recovery copy.
      message: body.code === 'validation' && typeof body.message === 'string' && body.message
        ? body.message
        : FAILURE_COPY[body.code],
      fields: body.fields && typeof body.fields === 'object' ? body.fields : {},
    };
  }
  if (reason instanceof TypeError || (reason && reason.name === 'AbortError')) {
    return { code: 'network', message: FAILURE_COPY.network, fields: {} };
  }
  return { code: 'internal', message: FAILURE_COPY.internal, fields: {} };
}

// User-facing copy for failures. The UI always adds that the user's text is kept.
export const FAILURE_COPY = Object.freeze({
  validation: 'Some details need attention.',
  not_found: 'This book was removed elsewhere. Copy anything you need, then cancel.',
  internal: 'Reading Nook couldn\'t save that. Nothing was changed.',
  network: 'Reading Nook couldn\'t be reached. Check the connection.',
});

export const ACTION_COPY = Object.freeze({
  create: {
    pending: (t) => `Adding “${t}” to your shelf…`,
    failed: 'Couldn\'t add this book.',
    done: (t) => `Added “${t}”.`,
  },
  update: {
    pending: (t) => `Saving “${t}”…`,
    failed: 'Couldn\'t save your changes.',
    done: (t) => `Saved “${t}”.`,
  },
  status: {
    pending: (t, s) => `Moving “${t}” to ${STATUS_LABELS[s]}…`,
    failed: (s) => `Couldn't move this book to ${STATUS_LABELS[s]}.`,
    done: (t, s) => `Moved “${t}” to ${STATUS_LABELS[s]}.`,
  },
  delete: {
    pending: (t) => `Removing “${t}”…`,
    failed: 'Couldn\'t remove this book.',
    done: (t) => `Removed “${t}”.`,
  },
  load: { pending: 'Opening your shelf…', failed: 'Your shelf couldn\'t be loaded.' },
  paused: 'Other changes wait until it finishes.',
});

// Client-side search/filter for the small list: case-insensitive match over title, author and notes.
export function matchesQuery(book, query) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return [book.title, book.author, book.notes].some((text) => text.toLocaleLowerCase().includes(q));
}

export function matchesFilters(book, { query = '', status = 'all' } = {}) {
  return (status === 'all' || book.status === status) && matchesQuery(book, query);
}

export function countByStatus(books) {
  const counts = { all: books.length, want_to_read: 0, reading: 0, finished: 0 };
  for (const book of books) counts[book.status] += 1;
  return counts;
}
