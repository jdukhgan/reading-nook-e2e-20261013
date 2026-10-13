// Reading Nook UI components.
//
// createReadingNook(root, callbacks) renders the whole shelf UI into `root` and
// returns state entry points. The controller (web/app.js) owns data and requests:
//
//   callbacks.onCreate(fields)          -> Promise<Book>   fields: { title, author, notes, status }
//   callbacks.onUpdate(id, patch)       -> Promise          patch: changed fields only
//   callbacks.onStatusChange(id, status)-> Promise
//   callbacks.onDelete(id)              -> Promise
//   callbacks.onRetryLoad()             -> void             (call ui.setLoading / setBooks / setLoadError)
//   callbacks.onSearch(query), onFilter(status)             optional notifications
//
// Mutation callbacks must call ui.setBooks(nextBooks) before resolving. Reject with the
// API error body ({ error: { code, message, fields } }), a fetch TypeError, or any Error;
// contract.normalizeError turns it into user copy. The UI keeps drafts and the list on
// failure, offers Try again, and manages pending, focus and announcements itself.
//
// All user text is rendered with textContent.

import {
  STATUSES,
  STATUS_LABELS,
  LIMITS,
  FIELD_LABELS,
  ACTION_COPY,
  charCount,
  validateBookInput,
  normalizeError,
  matchesFilters,
  countByStatus,
} from './contract.js';

const FILTERS = ['all', ...STATUSES];
const FILTER_LABELS = { all: 'All books', ...STATUS_LABELS };
const FIELD_ORDER = ['title', 'author', 'status', 'notes'];
const COVER_TONES = 6;
const SMALL_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'at', 'to', 'in', 'on', 'for', 'with', 'from', 'by', '&']);

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13 7l4 4"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7M9.5 7V4.5h5V7"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.1"/>',
  retry: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
};

let idCounter = 0;
const uid = (prefix) => `nook-${prefix}-${++idCounter}`;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child);
  return el;
}

function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  // Constant, authored markup only; never user data.
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// Typographic cover identity: bookcloth tone from a stable title hash, initials from significant words.
export function coverIdentity(title) {
  const clean = (title || '').trim();
  let hash = 2166136261;
  for (const ch of clean.toLocaleLowerCase()) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const words = clean.split(/\s+/).filter(Boolean);
  const significant = words.filter((w, i) => !(SMALL_WORDS.has(w.toLocaleLowerCase()) && (i > 0 || words.length > 1)));
  const initials = (significant.length ? significant : words)
    .slice(0, 2)
    .map((w) => (Array.from(w.replace(/^[^\p{L}\p{N}]+/u, ''))[0] || '').toLocaleUpperCase())
    .join('');
  return { tone: clean ? (hash % COVER_TONES) + 1 : 0, initials };
}

function createCover() {
  const mark = h('span', { class: 'cover__mark' });
  const el = h('div', { class: 'cover', 'aria-hidden': 'true' }, mark);
  return {
    el,
    update(title) {
      const { tone, initials } = coverIdentity(title);
      el.dataset.tone = String(tone);
      setText(mark, initials);
    },
  };
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function createReadingNook(root, callbacks = {}) {
  const state = {
    books: [],
    entries: new Map(), // id -> entry
    filters: { query: '', status: 'all' },
    load: 'idle', // idle | loading | ready | error
    loadFailed: false,
    pending: null, // { kind, entry, label }
    editor: null, // editor object (new or edit)
  };

  // ---------- Shell ----------
  const announcer = h('div', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const pendingNoteId = uid('pending');
  const pendingNote = h('p', { class: 'shelf-head__pending', id: pendingNoteId });

  const summary = h('p', { class: 'nook-summary' });
  const addButton = h('button', { type: 'button', class: 'btn btn--primary nook-add', dataset: { action: 'add', mutates: '' } },
    icon('plus'), h('span', { text: 'Add book' }));

  const searchId = uid('search');
  const searchInput = h('input', {
    id: searchId,
    class: 'search__input',
    type: 'search',
    placeholder: 'Search titles, authors, notes',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const search = h('div', { class: 'search', role: 'search' },
    h('label', { class: 'visually-hidden', for: searchId, text: 'Search your shelf' }),
    icon('search'), searchInput);

  const filterButtons = new Map();
  const filterCounts = new Map();
  const filterGroup = h('div', { class: 'filters', role: 'group', 'aria-label': 'Show books by status' },
    FILTERS.map((status) => {
      const count = h('span', { class: 'filters__count' });
      const button = h('button', {
        type: 'button',
        class: 'filters__item',
        'aria-pressed': status === 'all' ? 'true' : 'false',
        dataset: { action: 'filter', status },
      }, h('span', { class: 'filters__label', text: FILTER_LABELS[status] }), count);
      filterButtons.set(status, button);
      filterCounts.set(status, count);
      return button;
    }));

  const rail = h('header', { class: 'nook-rail' },
    h('div', { class: 'nook-brand' },
      h('h1', { class: 'wordmark' }, 'Reading ', h('em', { text: 'Nook' })),
      summary),
    addButton,
    h('div', { class: 'nook-tools' }, search, filterGroup));

  const shelfHeading = h('h2', { class: 'shelf-head__title', id: uid('shelf') });
  const shelfCount = h('span', { class: 'shelf-head__count' });
  const shelfHead = h('div', { class: 'shelf-head' }, h('div', { class: 'shelf-head__label' }, shelfHeading, shelfCount), pendingNote);

  // Shelf-level states: kept as persistent nodes so focus survives re-renders.
  const loadRetry = h('button', { type: 'button', class: 'btn btn--secondary', dataset: { action: 'retry-load' } }, icon('retry'), h('span', { text: 'Try again' }));
  const loadErrorText = h('p', { class: 'shelf-state__text' });
  const loadErrorId = uid('loaderr');
  const loadError = h('section', { class: 'shelf-state shelf-state--error', hidden: true, 'aria-labelledby': loadErrorId },
    h('h3', { class: 'shelf-state__title', id: loadErrorId, text: ACTION_COPY.load.failed }), loadErrorText, h('div', { class: 'shelf-state__actions' }, loadRetry));

  const bannerText = h('span', { class: 'banner__text' });
  const bannerRetry = h('button', { type: 'button', class: 'btn btn--quiet btn--small', dataset: { action: 'retry-load' } }, icon('retry'), h('span', { text: 'Try again' }));
  const banner = h('div', { class: 'banner', role: 'alert', hidden: true }, icon('alert'), bannerText, bannerRetry);

  const loading = h('div', { class: 'shelf-loading', hidden: true },
    h('p', { class: 'visually-hidden', text: ACTION_COPY.load.pending }),
    [0, 1, 2].map(() => h('div', { class: 'ghost', 'aria-hidden': 'true' },
      h('div', { class: 'ghost__cover' }), h('div', { class: 'ghost__lines' }, h('span'), h('span'), h('span')))));

  const emptyAdd = h('button', { type: 'button', class: 'btn btn--primary', dataset: { action: 'add', mutates: '' } }, icon('plus'), h('span', { text: 'Add your first book' }));
  const empty = h('section', { class: 'shelf-state shelf-state--empty', hidden: true },
    h('h3', { class: 'shelf-state__title', text: 'Your shelf is empty' }),
    h('p', { class: 'shelf-state__text', text: 'Add a book you want to read next. Notes are optional — a line about why it caught your eye is enough.' }),
    h('div', { class: 'shelf-state__actions' }, emptyAdd));

  const noMatchText = h('p', { class: 'shelf-state__text' });
  const noMatchClear = h('button', { type: 'button', class: 'btn btn--secondary', dataset: { action: 'clear-filters' }, text: 'Show all books' });
  const noMatch = h('section', { class: 'shelf-state shelf-state--quiet', hidden: true },
    h('h3', { class: 'shelf-state__title', text: 'Nothing on this shelf matches' }), noMatchText,
    h('div', { class: 'shelf-state__actions' }, noMatchClear));

  const newSlot = h('div', { class: 'new-slot' });
  const list = h('ol', { class: 'book-list', 'aria-labelledby': shelfHeading.id });

  const shelf = h('main', { class: 'shelf', 'aria-labelledby': shelfHeading.id },
    shelfHead, banner, newSlot, list, loading, loadError, empty, noMatch);

  const app = h('div', { class: 'nook' }, rail, shelf, announcer);
  root.replaceChildren(app);

  // ---------- Helpers ----------
  let announceTimer;
  function announce(message) {
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announceTimer = setTimeout(() => { announcer.textContent = message; }, 40);
  }

  function flash(el) {
    if (!el || prefersReducedMotion()) return;
    el.classList.remove('is-flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('is-flash');
    el.addEventListener('animationend', () => el.classList.remove('is-flash'), { once: true });
  }

  function isPinned(entry) {
    return entry.mode !== 'view' || entry.error != null || state.pending?.entry === entry;
  }

  function isVisible(entry) {
    return isPinned(entry) || matchesFilters(entry.book, state.filters);
  }

  function orderedEntries() {
    return state.books.map((b) => state.entries.get(b.id)).filter(Boolean);
  }

  function focusEntry(entry) {
    if (!entry || entry.li.hidden || entry.view.hidden || !entry.li.isConnected) return false;
    entry.editButton.focus();
    return true;
  }

  // Focus fallback when the opener or focused entry disappears: next visible book, previous visible book, Add book.
  function fallbackFocus(fromEntry, ordered = orderedEntries()) {
    const index = ordered.indexOf(fromEntry);
    const visible = (e) => e !== fromEntry && e.li.isConnected && !e.li.hidden;
    const after = index >= 0 ? ordered.slice(index + 1).find(visible) : null;
    const before = index >= 0 ? ordered.slice(0, index).reverse().find(visible) : null;
    if (!focusEntry(after || before || ordered.find(visible))) focusAddFallback();
  }

  function focusAddFallback() {
    (empty.hidden ? addButton : emptyAdd).focus();
  }

  // Focus left the page because its element was hidden or removed (e.g. a load retry that succeeded).
  function focusWasLost(previous) {
    const now = document.activeElement;
    return previous && app.contains(previous) && (now === document.body || now === null || now.closest('[hidden]') || !previous.isConnected || previous.closest('[hidden]'));
  }

  function notePaused() {
    const label = state.pending?.label;
    announce(label ? `Please wait — ${label}` : 'Please wait for the current change to finish.');
    pendingNote.classList.remove('is-nudged');
    void pendingNote.offsetWidth;
    pendingNote.classList.add('is-nudged');
  }

  // ---------- Pending ----------
  function setPending(pending) {
    state.pending = pending;
    app.classList.toggle('is-busy', Boolean(pending));
    setText(pendingNote, pending ? `${pending.label} ${ACTION_COPY.paused}` : '');
    for (const el of app.querySelectorAll('[data-mutates]')) {
      if (pending) {
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('aria-describedby', pendingNoteId);
      } else {
        el.removeAttribute('aria-disabled');
        el.removeAttribute('aria-describedby');
      }
    }
    const editor = state.editor;
    if (editor) {
      const busy = Boolean(pending && pending.entry === editor.entry);
      editor.form.classList.toggle('is-pending', busy);
      editor.form.setAttribute('aria-busy', String(busy));
      for (const input of [editor.inputs.title, editor.inputs.author, editor.inputs.notes]) input.readOnly = busy;
      setText(editor.saveLabel, busy ? editor.savingText : editor.saveText);
      if (busy && !(editor.retrying && editor.feedback.markRetrying())) editor.setFeedback('pending', pending.label);
    }
    for (const entry of state.entries.values()) {
      const busy = Boolean(pending && pending.entry === entry);
      entry.li.classList.toggle('is-pending', busy);
      if (busy) entry.li.setAttribute('aria-busy', 'true');
      else entry.li.removeAttribute('aria-busy');
      setText(entry.confirmRemoveLabel, busy && pending.kind === 'delete' ? 'Removing…' : 'Remove');
    }
    newSlot.firstElementChild?.classList.toggle('is-pending', Boolean(pending?.entry?.isNew));
  }

  async function runMutation({ kind, entry, label, invoke, onSuccess, onFailure }) {
    if (state.pending) { notePaused(); return; }
    setPending({ kind, entry, label });
    announce(label);
    let result;
    try {
      result = await Promise.resolve().then(invoke);
    } catch (reason) {
      setPending(null);
      // Set the error first so the entry stays pinned (visible) while focus moves to Try again.
      onFailure(normalizeError(reason));
      applyVisibility();
      return;
    }
    setPending(null);
    applyVisibility();
    onSuccess(result);
  }

  function call(name, ...args) {
    if (typeof callbacks[name] !== 'function') throw new Error(`Missing callback ${name}`);
    return callbacks[name](...args);
  }

  // ---------- Feedback (inline alert + Try again) ----------
  function createFeedback(retryAction) {
    const el = h('div', { class: 'feedback' });
    return {
      el,
      retry: null,
      set(kind, message, detail) {
        el.dataset.kind = kind || '';
        this.retry = null;
        if (!kind) { el.replaceChildren(); return; }
        if (kind === 'pending' || kind === 'info') {
          el.replaceChildren(h('p', { class: 'feedback__text', text: message }));
          return;
        }
        this.retry = h('button', { type: 'button', class: 'btn btn--secondary btn--small', dataset: { action: retryAction } }, icon('retry'), h('span', { text: 'Try again' }));
        el.replaceChildren(h('div', { class: 'feedback__alert', role: 'alert' },
          icon('alert'),
          h('p', { class: 'feedback__text' }, h('strong', { text: message }), detail ? ` ${detail}` : ''),
          this.retry));
      },
      // Retrying keeps the alert in place (stable geometry, focus stays on the button) until the outcome.
      markRetrying() {
        if (!this.retry) return false;
        this.retry.setAttribute('aria-disabled', 'true');
        this.retry.classList.add('is-busy');
        setText(this.retry.lastElementChild, 'Trying…');
        return true;
      },
    };
  }

  // ---------- Book entry ----------
  function createEntry(book) {
    const cover = createCover();
    const title = h('h3', { class: 'book__title' });
    const author = h('p', { class: 'book__author' });
    const notes = h('p', { class: 'book__notes' });
    const selectId = uid('status');
    const selectLabel = h('label', { class: 'visually-hidden', for: selectId });
    const select = h('select', { id: selectId, class: 'status-select', dataset: { action: 'status', mutates: '' } },
      STATUSES.map((s) => h('option', { value: s, text: STATUS_LABELS[s] })));
    const editButton = h('button', { type: 'button', class: 'btn btn--quiet btn--small', dataset: { action: 'edit', mutates: '' } }, icon('edit'), h('span', { text: 'Edit' }));
    const deleteButton = h('button', { type: 'button', class: 'btn btn--quiet btn--small btn--danger-quiet', dataset: { action: 'delete', mutates: '' } }, icon('trash'), h('span', { text: 'Delete' }));
    const confirmText = h('span', { class: 'confirm__text' });
    const confirmRemoveLabel = h('span', { text: 'Remove' });
    const confirmRemove = h('button', { type: 'button', class: 'btn btn--danger btn--small confirm__remove', dataset: { action: 'confirm-delete', mutates: '' } }, confirmRemoveLabel);
    const confirmKeep = h('button', { type: 'button', class: 'btn btn--secondary btn--small', dataset: { action: 'cancel-delete', mutates: '' }, text: 'Keep' });
    const confirm = h('div', { class: 'confirm', hidden: true }, confirmText, h('div', { class: 'confirm__buttons' }, confirmKeep, confirmRemove));
    const actions = h('div', { class: 'book__actions' }, editButton, deleteButton);
    const feedback = createFeedback('retry-entry');
    const view = h('div', { class: 'book__view' },
      h('div', { class: 'book__line' }, title, h('span', { class: 'book__leader', 'aria-hidden': 'true' })),
      h('div', { class: 'book__status' }, selectLabel, select),
      author, notes,
      h('div', { class: 'book__controls' }, actions, confirm),
      feedback.el);
    const li = h('li', { class: 'book', dataset: { id: String(book.id) } }, cover.el, view);
    const entry = {
      id: book.id, book: null, li, view, cover, title, author, notes, select, selectLabel,
      editButton, deleteButton, actions, confirm, confirmText, confirmRemove, confirmRemoveLabel, confirmKeep, feedback,
      mode: 'view', error: null, retry: null, isNew: false,
    };
    updateEntry(entry, book);
    return entry;
  }

  function updateEntry(entry, book) {
    entry.book = book;
    entry.li.dataset.status = book.status;
    entry.cover.update(book.title);
    setText(entry.title, book.title);
    setText(entry.author, book.author);
    setText(entry.notes, book.notes);
    entry.notes.hidden = book.notes === '';
    setText(entry.selectLabel, `Status of ${book.title}`);
    if (!(state.pending?.entry === entry && state.pending.kind === 'status')) entry.select.value = book.status;
    entry.select.dataset.status = book.status;
    setText(entry.confirmText, `Remove “${book.title}”?`);
  }

  function setEntryError(entry, error, retry) {
    entry.error = error;
    entry.retry = retry;
    if (!error) { entry.feedback.set(null); return; }
    entry.feedback.set('error', error.title, `${error.message}`);
  }

  function showConfirm(entry, on) {
    entry.mode = on ? 'confirm' : 'view';
    entry.actions.hidden = on;
    entry.confirm.hidden = !on;
    if (on) entry.confirmKeep.focus();
  }

  // ---------- Editor ----------
  function createEditor({ book, entry }) {
    const isNew = !book;
    const ids = { title: uid('title'), author: uid('author'), notes: uid('notes') };
    const inputs = {};
    const messages = {};
    const counters = {};

    function textField(field, control) {
      const msg = h('span', { class: 'field__msg', id: `${ids[field]}-msg` });
      const count = h('span', { class: 'field__count', 'aria-hidden': 'true' });
      messages[field] = msg;
      counters[field] = count;
      inputs[field] = control;
      control.setAttribute('aria-describedby', msg.id);
      return h('div', { class: `field field--${field}` },
        h('label', { class: 'field__label', for: ids[field], text: FIELD_LABELS[field] }),
        control,
        h('div', { class: 'field__meta' }, msg, count));
    }

    const titleInput = h('input', { id: ids.title, name: 'title', class: 'input input--title', type: 'text', autocomplete: 'off', required: true });
    const authorInput = h('input', { id: ids.author, name: 'author', class: 'input', type: 'text', autocomplete: 'off', required: true });
    const notesInput = h('textarea', { id: ids.notes, name: 'notes', class: 'input input--notes', rows: '4' });
    const statusName = uid('status-choice');
    const statusMsg = h('span', { class: 'field__msg', id: `${statusName}-msg` });
    messages.status = statusMsg;
    const radios = STATUSES.map((s) => h('input', { type: 'radio', name: statusName, value: s, class: 'segmented__input', id: `${statusName}-${s}` }));
    const statusField = h('fieldset', { class: 'field field--status', 'aria-describedby': statusMsg.id },
      h('legend', { class: 'field__label', text: FIELD_LABELS.status }),
      h('div', { class: 'segmented' }, STATUSES.map((s, i) => h('label', { class: 'segmented__item', for: radios[i].id }, radios[i], h('span', { text: STATUS_LABELS[s] })))),
      h('div', { class: 'field__meta' }, statusMsg));

    const saveText = isNew ? 'Add to shelf' : 'Save changes';
    const saveLabel = h('span', { text: saveText });
    const save = h('button', { type: 'submit', class: 'btn btn--primary editor__save', dataset: { mutates: '' } }, saveLabel);
    const cancel = h('button', { type: 'button', class: 'btn btn--secondary', dataset: { action: 'cancel-edit', mutates: '' }, text: 'Cancel' });
    const feedback = createFeedback('retry-editor');
    const headingId = uid('editor-heading');
    const heading = isNew ? h('h3', { class: 'editor__heading', id: headingId, text: 'Add a book' }) : null;

    const form = h('form', {
      class: 'editor',
      novalidate: true,
      'aria-label': isNew ? null : `Edit ${book.title}`,
      'aria-labelledby': isNew ? headingId : null,
    },
    heading,
    h('div', { class: 'editor__grid' },
      textField('title', titleInput),
      textField('author', authorInput),
      statusField,
      textField('notes', notesInput)),
    h('div', { class: 'editor__footer' }, h('div', { class: 'editor__actions' }, cancel, save), feedback.el));
    inputs.title = titleInput;
    inputs.author = authorInput;
    inputs.notes = notesInput;

    const initial = {
      title: book?.title ?? '',
      author: book?.author ?? '',
      notes: book?.notes ?? '',
      status: book?.status ?? (state.filters.status !== 'all' ? state.filters.status : 'want_to_read'),
    };
    titleInput.value = initial.title;
    authorInput.value = initial.author;
    notesInput.value = initial.notes;
    radios.find((r) => r.value === initial.status).checked = true;

    const editor = {
      isNew, book, entry, form, inputs, radios, messages, counters, save, saveLabel, cancel, feedback,
      saveText, savingText: isNew ? 'Adding…' : 'Saving…', initial, opener: null, retryable: false,
      read() {
        return {
          title: titleInput.value,
          author: authorInput.value,
          notes: notesInput.value,
          status: radios.find((r) => r.checked)?.value ?? initial.status,
        };
      },
      dirty() {
        const now = this.read();
        return Object.keys(initial).some((k) => now[k] !== initial[k]);
      },
      setFeedback(kind, message, detail) {
        feedback.set(kind, message, detail);
      },
      setErrors(fields = {}) {
        for (const field of FIELD_ORDER) {
          const msg = fields[field] || '';
          setText(messages[field], msg);
          const target = field === 'status' ? statusField : inputs[field];
          if (msg) target.setAttribute('aria-invalid', 'true');
          else target.removeAttribute('aria-invalid');
        }
      },
      focusFirstInvalid(fields) {
        const field = FIELD_ORDER.find((f) => fields[f]);
        if (!field) return false;
        (field === 'status' ? radios.find((r) => r.checked) || radios[0] : inputs[field]).focus();
        return true;
      },
      updateCount(field) {
        const n = charCount(inputs[field].value.trim());
        const limit = LIMITS[field];
        const show = field === 'notes' || n >= Math.floor(limit * 0.8);
        setText(counters[field], show ? `${n} / ${limit}` : '');
        counters[field].classList.toggle('is-over', n > limit);
      },
    };

    for (const field of ['title', 'author', 'notes']) {
      editor.updateCount(field);
      inputs[field].addEventListener('input', () => {
        editor.updateCount(field);
        if (messages[field].textContent) {
          setText(messages[field], '');
          inputs[field].removeAttribute('aria-invalid');
        }
        if (field === 'title') entry.cover.update(titleInput.value || book?.title || '');
      });
    }
    // Radios cannot be read-only; block changes while this editor is saving.
    statusField.addEventListener('click', (event) => {
      if (state.pending && event.target.matches('input[type="radio"]')) { event.preventDefault(); notePaused(); }
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); submitEditor(editor); });
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (state.pending) notePaused();
        else closeEditor(editor, { restoreFocus: true, announceText: 'Edit cancelled.' });
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitEditor(editor);
      }
    });
    return editor;
  }

  function openEditor(target, opener) {
    if (state.pending) { notePaused(); return; }
    const current = state.editor;
    if (current) {
      const same = target === 'new' ? current.isNew : current.entry === target;
      if (same) { current.inputs.title.focus(); return; }
      if (current.dirty()) {
        current.setFeedback('info', `Save or cancel “${current.read().title.trim() || 'this book'}” first — your changes are still here.`);
        current.inputs.title.focus();
        announce('Save or cancel the open book first.');
        return;
      }
      closeEditor(current, { restoreFocus: false });
    }

    let editor;
    if (target === 'new') {
      const cover = createCover();
      const li = h('div', { class: 'book book--new' }, cover.el);
      const entry = { isNew: true, li, cover, mode: 'edit', error: null };
      editor = createEditor({ book: null, entry });
      cover.update('');
      li.append(editor.form);
      newSlot.replaceChildren(li);
    } else {
      const entry = target;
      if (entry.mode === 'confirm') showConfirm(entry, false);
      setEntryError(entry, null);
      editor = createEditor({ book: entry.book, entry });
      entry.mode = 'edit';
      entry.view.hidden = true;
      entry.li.classList.add('is-editing');
      entry.li.append(editor.form);
    }
    editor.opener = opener;
    state.editor = editor;
    applyVisibility();
    editor.inputs.title.focus({ preventScroll: true });
    editor.form.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  function closeEditor(editor, { restoreFocus, announceText } = {}) {
    if (state.editor !== editor) return;
    state.editor = null;
    const { entry } = editor;
    if (editor.isNew) {
      newSlot.replaceChildren();
    } else {
      editor.form.remove();
      entry.view.hidden = false;
      entry.li.classList.remove('is-editing');
      entry.mode = 'view';
      entry.cover.update(entry.book.title);
    }
    applyVisibility();
    if (announceText) announce(announceText);
    if (!restoreFocus) return;
    const opener = editor.opener;
    if (opener && opener.isConnected && !opener.closest('[hidden]')) opener.focus();
    else if (!editor.isNew) fallbackFocus(entry);
    else addButton.focus();
  }

  function submitEditor(editor, { retry = false } = {}) {
    if (state.pending) { notePaused(); return; }
    editor.retrying = retry;
    const raw = editor.read();
    const check = validateBookInput(raw);
    if (!check.ok) {
      editor.setErrors(check.fields);
      editor.setFeedback(null);
      editor.focusFirstInvalid(check.fields);
      announce('Some details need attention.');
      return;
    }
    editor.setErrors({});
    const value = check.value;
    if (editor.isNew) {
      runMutation({
        kind: 'create', entry: editor.entry, label: ACTION_COPY.create.pending(value.title),
        invoke: () => call('onCreate', value),
        onSuccess: (book) => {
          closeEditor(editor, { restoreFocus: false });
          const entry = book && state.entries.get(book.id);
          announce(ACTION_COPY.create.done(value.title) + (entry && !isVisible(entry) ? ' It is hidden by the current filter.' : ''));
          if (entry && focusEntry(entry)) flash(entry.li);
          else addButton.focus();
        },
        onFailure: (error) => editorFailed(editor, ACTION_COPY.create.failed, error),
      });
      return;
    }
    const patch = {};
    for (const key of Object.keys(value)) if (value[key] !== editor.book[key]) patch[key] = value[key];
    if (Object.keys(patch).length === 0) {
      closeEditor(editor, { restoreFocus: true, announceText: 'No changes to save.' });
      return;
    }
    const { entry } = editor;
    runMutation({
      kind: 'update', entry, label: ACTION_COPY.update.pending(value.title),
      invoke: () => call('onUpdate', entry.id, patch),
      onSuccess: () => {
        closeEditor(editor, { restoreFocus: false });
        if (!entry.li.isConnected) { fallbackFocus(entry); return; }
        const visible = isVisible(entry);
        announce(ACTION_COPY.update.done(entry.book.title) + (visible ? '' : ' It is hidden by the current filter.'));
        if (visible) { focusEntry(entry); flash(entry.li); } else fallbackFocus(entry);
      },
      onFailure: (error) => editorFailed(editor, ACTION_COPY.update.failed, error),
    });
  }

  function editorFailed(editor, title, error) {
    const fields = error.fields || {};
    editor.setErrors(fields);
    const general = fields._ ? ` ${fields._}` : '';
    editor.setFeedback('error', title, `${error.message}${general} Your text is still here.`);
    announce(`${title} ${error.message}`);
    if (!editor.focusFirstInvalid(fields)) editor.feedback.retry?.focus();
  }

  // ---------- Status and delete ----------
  // Clear an entry's alert after a successful retry without dropping focus to <body>.
  function clearEntryError(entry, focusTarget) {
    const hadFocus = entry.feedback.el.contains(document.activeElement);
    setEntryError(entry, null);
    if (hadFocus && focusTarget && !entry.li.hidden) focusTarget.focus({ preventScroll: true });
  }

  function changeStatus(entry, status, { retry = false } = {}) {
    const from = entry.book.status;
    if (status === from) { clearEntryError(entry, entry.select); applyVisibility(); return; }
    if (!(retry && entry.feedback.markRetrying())) setEntryError(entry, null);
    runMutation({
      kind: 'status', entry, label: ACTION_COPY.status.pending(entry.book.title, status),
      invoke: () => call('onStatusChange', entry.id, status),
      onSuccess: () => {
        entry.select.value = entry.book.status;
        clearEntryError(entry, entry.select);
        applyVisibility();
        const visible = isVisible(entry);
        announce(ACTION_COPY.status.done(entry.book.title, status) + (visible ? '' : ' It is hidden by the current filter.'));
        if (visible) flash(entry.li);
        else fallbackFocus(entry);
      },
      onFailure: (error) => {
        entry.select.value = entry.book.status;
        setEntryError(entry, { title: ACTION_COPY.status.failed(status), message: error.message }, () => changeStatus(entry, status, { retry: true }));
        announce(`Couldn't move “${entry.book.title}”. ${error.message}`);
        entry.feedback.retry?.focus();
      },
    });
  }

  function deleteBook(entry, { retry = false } = {}) {
    if (!(retry && entry.feedback.markRetrying())) setEntryError(entry, null);
    const title = entry.book.title;
    runMutation({
      kind: 'delete', entry, label: ACTION_COPY.delete.pending(title),
      invoke: () => call('onDelete', entry.id),
      onSuccess: () => {
        announce(ACTION_COPY.delete.done(title));
        // setBooks removed the entry and moved focus; if the controller kept it, return to view mode.
        if (entry.li.isConnected) { setEntryError(entry, null); showConfirm(entry, false); focusEntry(entry); }
      },
      onFailure: (error) => {
        setEntryError(entry, { title: ACTION_COPY.delete.failed, message: error.message }, () => deleteBook(entry, { retry: true }));
        announce(`${ACTION_COPY.delete.failed} ${error.message}`);
        entry.feedback.retry?.focus();
      },
    });
  }

  // ---------- Visibility, counts, shelf states ----------
  function applyVisibility() {
    let visibleCount = 0;
    for (const entry of state.entries.values()) {
      const visible = isVisible(entry);
      if (entry.li.hidden === visible) entry.li.hidden = !visible;
      if (visible) visibleCount += 1;
    }
    const counts = countByStatus(state.books);
    const n = state.books.length;
    // Before the first successful load the counts are unknown, not zero.
    const known = state.load === 'ready' || n > 0;
    for (const status of FILTERS) {
      setText(filterCounts.get(status), known ? String(counts[status]) : '');
      filterButtons.get(status).setAttribute('aria-pressed', String(state.filters.status === status));
    }
    let summaryText = '';
    if (n > 0) summaryText = `${n} ${n === 1 ? 'book' : 'books'} · ${counts.reading} reading now`;
    else if (state.load === 'ready') summaryText = 'No books yet';
    else if (state.load === 'loading' && !state.loadFailed) summaryText = ACTION_COPY.load.pending;
    setText(summary, summaryText);

    const query = state.filters.query.trim();
    setText(shelfHeading, query ? 'Search results' : FILTER_LABELS[state.filters.status]);
    setText(shelfCount, state.load === 'ready' || n ? String(visibleCount) : '');

    // After a load failure the error panel/banner (and its Try again button) stays in place through the
    // retry's loading phase, so focus and geometry don't jump; setBooks clears it.
    const ready = state.load === 'ready';
    const hasNew = Boolean(state.editor?.isNew);
    loading.hidden = !(state.load === 'loading' && n === 0 && !state.loadFailed);
    loadError.hidden = !(state.loadFailed && n === 0);
    banner.hidden = !(state.loadFailed && n > 0);
    empty.hidden = !(ready && n === 0 && !hasNew);
    noMatch.hidden = !(n > 0 && visibleCount === 0 && !hasNew);
    if (!noMatch.hidden) {
      const where = state.filters.status === 'all' ? 'on your shelf' : `in ${FILTER_LABELS[state.filters.status]}`;
      setText(noMatchText, query ? `No books ${where} mention “${query}”.` : `No books ${where} yet.`);
    }
    list.hidden = n === 0;
  }

  function setRetryBusy(busy) {
    for (const button of [loadRetry, bannerRetry]) {
      if (busy) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
      button.classList.toggle('is-busy', busy);
      setText(button.lastElementChild, busy ? 'Trying…' : 'Try again');
    }
  }

  function setFilters(next, { notify = false } = {}) {
    const prev = state.filters;
    state.filters = {
      query: typeof next.query === 'string' ? next.query : prev.query,
      status: FILTERS.includes(next.status) ? next.status : prev.status,
    };
    if (searchInput.value !== state.filters.query) searchInput.value = state.filters.query;
    applyVisibility();
    if (notify && prev.query !== state.filters.query) callbacks.onSearch?.(state.filters.query);
    if (notify && prev.status !== state.filters.status) callbacks.onFilter?.(state.filters.status);
  }

  // ---------- Events ----------
  searchInput.addEventListener('input', () => setFilters({ query: searchInput.value }, { notify: true }));

  app.addEventListener('click', (event) => {
    const control = event.target.closest('[data-action]');
    if (!control || !app.contains(control) || control.tagName === 'SELECT') return;
    if (control.getAttribute('aria-disabled') === 'true') { event.preventDefault(); notePaused(); return; }
    const entry = state.entries.get(Number(control.closest('.book')?.dataset.id));
    switch (control.dataset.action) {
      case 'add': openEditor('new', control); break;
      case 'filter': setFilters({ status: control.dataset.status }, { notify: true }); break;
      case 'clear-filters': setFilters({ query: '', status: 'all' }, { notify: true }); filterButtons.get('all').focus(); break;
      case 'edit': openEditor(entry, control); break;
      case 'delete': showConfirm(entry, true); break;
      case 'cancel-delete': showConfirm(entry, false); setEntryError(entry, null); applyVisibility(); entry.deleteButton.focus(); break;
      case 'confirm-delete': deleteBook(entry); break;
      case 'cancel-edit': closeEditor(state.editor, { restoreFocus: true, announceText: 'Edit cancelled.' }); break;
      case 'retry-editor': submitEditor(state.editor, { retry: true }); break;
      case 'retry-entry': entry?.retry?.(); break;
      case 'retry-load':
        if (state.load === 'loading') { announce(ACTION_COPY.load.pending); break; }
        callbacks.onRetryLoad?.();
        break;
      default: break;
    }
  });

  app.addEventListener('change', (event) => {
    const select = event.target;
    if (!select.matches('select[data-action="status"]')) return;
    const entry = state.entries.get(Number(select.closest('.book').dataset.id));
    if (state.pending || state.editor?.entry === entry) {
      select.value = entry.book.status;
      notePaused();
      return;
    }
    changeStatus(entry, select.value);
  });

  app.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const entry = state.entries.get(Number(event.target.closest?.('.book')?.dataset.id));
    if (entry?.mode === 'confirm' && !state.pending) {
      showConfirm(entry, false);
      entry.deleteButton.focus();
    }
  });

  // ---------- Public entry points ----------
  const ui = {
    /** Replace the full book list (controller order is preserved). Keeps DOM identity, drafts, focus and scroll. */
    setBooks(books) {
      const active = document.activeElement;
      const prevOrder = orderedEntries();
      const next = new Map();
      for (const book of books) {
        const entry = state.entries.get(book.id) || createEntry(book);
        if (entry.book !== book) updateEntry(entry, book);
        next.set(book.id, entry);
      }
      let focusLostFrom = null;
      for (const [id, entry] of state.entries) {
        if (next.has(id)) continue;
        if (entry.li.contains(active)) focusLostFrom = entry;
        if (state.editor?.entry === entry) state.editor = null;
      }
      state.books = books.slice();
      const removed = [...state.entries.values()].filter((e) => !next.has(e.id));
      state.entries = next;
      // Reorder in place: move only nodes that are out of position.
      let cursor = list.firstElementChild;
      for (const book of books) {
        const li = next.get(book.id).li;
        if (li === cursor) cursor = cursor.nextElementSibling;
        else list.insertBefore(li, cursor);
      }
      state.load = 'ready';
      state.loadFailed = false;
      setRetryBusy(false);
      applyVisibility();
      if (focusLostFrom) {
        // Removed entries are still in the DOM here, so "next visible" is measured from the old position.
        fallbackFocus(focusLostFrom, prevOrder.filter((e) => e === focusLostFrom || next.has(e.id)));
      } else if (focusWasLost(active)) {
        const first = orderedEntries().find((e) => !e.li.hidden);
        if (!focusEntry(first)) focusAddFallback();
      } else if (active && active !== document.activeElement && active.isConnected) {
        // A moved node loses focus in some browsers; put it back without scrolling.
        active.focus({ preventScroll: true });
      }
      for (const entry of removed) entry.li.remove();
    },

    /** Show the loading state: placeholder rows on first load; during a retry the error stays with a busy Try again. */
    setLoading() {
      state.load = 'loading';
      setRetryBusy(true);
      applyVisibility();
    },

    /** Show a load failure with Try again. Keeps any list already shown (banner above it). */
    setLoadError(reason) {
      const error = normalizeError(reason);
      state.load = 'error';
      state.loadFailed = true;
      setRetryBusy(false);
      setText(loadErrorText, `${error.message} Your books are safe; nothing was changed.`);
      setText(bannerText, `Couldn't refresh your shelf. ${error.message} Showing the books loaded earlier.`);
      applyVisibility();
      announce(`${ACTION_COPY.load.failed} ${error.message}`);
    },

    /** Set search text and/or status filter ('all' | status). Does not fire onSearch/onFilter. */
    setFilters(filters) { setFilters(filters || {}); },

    /** Open the editor for a book id, or 'new' for the add form. */
    openEditor(target = 'new') {
      if (target === 'new') { openEditor('new', addButton); return; }
      const entry = state.entries.get(target);
      if (entry) openEditor(entry, entry.editButton);
    },

    /** Read-only snapshot for tests and diagnostics. */
    getState() {
      return {
        load: state.load,
        filters: { ...state.filters },
        pending: state.pending ? { kind: state.pending.kind, id: state.pending.entry?.id ?? null } : null,
        editor: state.editor ? { id: state.editor.isNew ? 'new' : state.editor.entry.id, dirty: state.editor.dirty() } : null,
        visibleIds: orderedEntries().filter((e) => !e.li.hidden).map((e) => e.id),
      };
    },

    focusAdd() { addButton.focus(); },
  };

  applyVisibility();
  return ui;
}
