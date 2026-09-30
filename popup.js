// The manager: the toolbar popup (popup.html) and the full-page view
// (options.html) are the same UI. It never edits anything itself; every change
// is a message to the service worker, and the list redraws from what comes back.

const isPage = document.body.classList.contains('page');
const app = document.getElementById('app');

const GROUP_COLORS = {
  grey: '#80868b', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};

const ICONS = {
  pin: '<path d="M9.5 2.5 13.5 6.5 11 7.5 9 10.5 9.5 13 3 6.5 5.5 7 8.5 5Z"/><path d="M6 10 2.5 13.5"/>',
  edit: '<path d="M2.5 13.5 3 10.5 10.5 3 13 5.5 5.5 13Z"/><path d="M9 4.5 11.5 7"/>',
  close: '<path d="M4 4 12 12M12 4 4 12"/>',
  trash: '<path d="M3 4.5H13M6.5 4.5V3H9.5V4.5M4.5 4.5 5 13H11L11.5 4.5"/>',
  folder: '<path d="M2 4.5C2 3.9 2.4 3.5 3 3.5H6L7.5 5H13C13.6 5 14 5.4 14 6V11.5C14 12.1 13.6 12.5 13 12.5H3C2.4 12.5 2 12.1 2 11.5Z"/><path d="M8 7.5V10.5M6.5 9H9.5"/>',
  plus: '<path d="M8 3V13M3 8H13"/>',
  link: '<path d="M7 9C7.8 10 9.3 10.1 10.2 9.2L12.2 7.2C13.1 6.3 13.1 4.8 12.2 3.9 11.3 3 9.8 3 8.9 3.9L8.2 4.6"/><path d="M9 7C8.2 6 6.7 5.9 5.8 6.8L3.8 8.8C2.9 9.7 2.9 11.2 3.8 12.1 4.7 13 6.2 13 7.1 12.1L7.8 11.4"/>',
  home: '<path d="M2.5 8 8 3 13.5 8M4 7V13H12V7"/>',
  chevron: '<path d="M6 4 10 8 6 12"/>',
  restore: '<path d="M3 8A5 5 0 1 0 4.5 4.4M3 3V5.5H5.5"/>',
  open: '<path d="M6.5 3.5H3.5V12.5H12.5V9.5M9 3.5H12.5V7M12.5 3.5 7.5 8.5"/>',
};

let state = null;
let here = { tabId: null, windowId: null };
const ui = { editing: null, palette: null, adding: null, settings: false, trash: false, error: '' };
let drag = null;

// ---------------------------------------------------------------- helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || (value === false && !(key in el))) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

const iconButton = (name, label, onclick, extra = '') =>
  h('button', { class: `icon-button ${extra}`, type: 'button', title: label, 'aria-label': label, onclick }, icon(name));

const pinName = (pin) => pin.title || pin.pageTitle || hostOf(pin.url) || pin.url;

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') || parsed.protocol;
  } catch {
    return '';
  }
}

const faviconOf = (pin) =>
  pin.favicon || chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pin.url)}&size=32`);

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? 'The extension did not answer.');
  return response.result;
}

// Ask the worker to do something, then redraw from the result.
async function run(type, payload) {
  try {
    ui.error = '';
    await send(type, payload);
  } catch (error) {
    ui.error = error.message;
  }
  await refresh();
}

async function refresh() {
  state = await send('get-state', here);
  render();
}

// ---------------------------------------------------------------- inline editing

// A text field that stands in for a label. Enter or leaving it saves, Esc cancels.
function editor({ value, placeholder, label, onsave }) {
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    ui.editing = null;
    ui.adding = null;
    if (save) onsave(input.value);
    else render();
  };
  const input = h('input', {
    class: 'editor', type: 'text', value, placeholder, 'aria-label': label, spellcheck: false,
    onkeydown: (event) => {
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      }
    },
    onblur: () => finish(true),
    onclick: (event) => event.stopPropagation(),
  });
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

const isEditing = (kind, id) => ui.editing?.kind === kind && ui.editing.id === id;

function edit(kind, id) {
  ui.editing = { kind, id };
  ui.palette = null;
  render();
}

// ---------------------------------------------------------------- drag and drop

function dropSide(event, el) {
  const box = el.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? 'before' : 'after';
}

function clearDropMarks() {
  for (const el of app.querySelectorAll('.drop-before, .drop-after, .drop-into')) {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  }
}

function draggable(el, item) {
  el.draggable = true;
  el.addEventListener('dragstart', (event) => {
    if (event.target.closest('input')) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    drag = item;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    drag = null;
    el.classList.remove('dragging');
    clearDropMarks();
  });
}

// `accepts(drag)` says whether the thing being dragged may land here;
// `ondrop(drag, side)` gets 'before', 'after' or 'into'.
function dropTarget(el, { accepts, into = false, ondrop }) {
  el.addEventListener('dragover', (event) => {
    if (!drag || !accepts(drag)) return;
    event.preventDefault();
    event.stopPropagation();
    clearDropMarks();
    el.classList.add(into ? 'drop-into' : `drop-${dropSide(event, el)}`);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  el.addEventListener('drop', (event) => {
    if (!drag || !accepts(drag)) return;
    event.preventDefault();
    event.stopPropagation();
    const side = into ? 'into' : dropSide(event, el);
    const item = drag;
    drag = null;
    clearDropMarks();
    ondrop(item, side);
  });
}

function movePin(pinId, folderId, target, side) {
  const siblings = state.model.pins.filter((p) => p.folderId === folderId && p.id !== pinId);
  let index = siblings.length;
  if (target) index = siblings.findIndex((p) => p.id === target) + (side === 'after' ? 1 : 0);
  run('move-pin', { pinId, folderId, index });
}

function moveFolder(folderId, target, side) {
  const others = state.model.folders.filter((f) => f.id !== folderId);
  const index = others.findIndex((f) => f.id === target) + (side === 'after' ? 1 : 0);
  run('move-folder', { folderId, index });
}

// ---------------------------------------------------------------- sections

function header() {
  return h('header', {},
    h('img', { src: 'icons/icon128.png', alt: '', width: isPage ? 40 : 24, height: isPage ? 40 : 24 }),
    h('div', { class: 'title' },
      h('h1', {}, 'Super Pins'),
      isPage && h('p', {}, 'Pinned tabs that stay put: in every window, after every restart.')),
    h('button', {
      class: 'button', type: 'button',
      onclick: () => {
        ui.adding = { kind: 'folder' };
        render();
      },
    }, icon('folder'), 'New folder'),
    !isPage && iconButton('open', 'Open the full manager', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    }));
}

function currentCard() {
  const current = state.current;
  if (isPage || !current) return null;

  if (current.pinId) {
    const pin = state.model.pins.find((p) => p.id === current.pinId);
    return h('section', { class: 'card current' },
      h('div', { class: 'current-line' },
        h('img', { class: 'favicon', src: faviconOf(pin), alt: '' }),
        h('div', { class: 'grow' },
          h('strong', {}, pinName(pin)),
          h('small', {}, current.away ? 'Away from its pinned page' : 'This tab is a super pin'))),
      h('div', { class: 'actions' },
        h('button', { class: 'button', type: 'button', onclick: () => edit('pin', pin.id) }, 'Rename'),
        current.away && h('button', {
          class: 'button', type: 'button', title: pin.url,
          onclick: () => run('reset-pin', { tabId: current.tabId }).then(() => window.close()),
        }, 'Back to pinned page'),
        current.away && h('button', {
          class: 'button', type: 'button',
          onclick: () => run('use-current-url', { tabId: current.tabId }),
        }, 'Pin this page instead'),
        h('button', {
          class: 'button danger', type: 'button',
          onclick: () => run('unpin', { pinId: pin.id }),
        }, 'Unpin')));
  }

  if (!current.pinnable) {
    return h('section', { class: 'card current muted' }, "This page can't be pinned.");
  }

  const folders = state.model.folders;
  const select = folders.length > 1 && h('select', { 'aria-label': 'Folder' },
    folders.map((f) => h('option', { value: f.id }, f.title || 'Untitled folder')));
  return h('section', { class: 'card current' },
    h('div', { class: 'actions' },
      h('button', {
        class: 'button primary grow', type: 'button',
        onclick: () => run('pin-tab', { tabId: current.tabId, folderId: select ? select.value : undefined }),
      }, icon('pin'), 'Super pin this tab'),
      select));
}

function pinRow(pin) {
  const live = state.live[pin.id];
  const row = h('li', {
    class: `pin ${live?.loaded ? 'loaded' : ''} ${live?.active ? 'active' : ''}`,
    title: pin.url,
    onclick: () => {
      if (isEditing('pin', pin.id) || here.windowId == null) return;
      send('open-pin', { pinId: pin.id, windowId: here.windowId }).then(() => {
        if (!isPage) window.close();
      });
    },
  },
    h('img', { class: 'favicon', src: faviconOf(pin), alt: '', draggable: false }),
    isEditing('pin', pin.id)
      ? editor({
        value: pin.title ?? '',
        placeholder: pin.pageTitle || hostOf(pin.url),
        label: 'Pin name',
        onsave: (title) => run('rename-pin', { pinId: pin.id, title }),
      })
      : h('span', { class: 'name grow' }, pinName(pin), pinName(pin) !== hostOf(pin.url) && h('small', {}, hostOf(pin.url))),
    h('span', { class: 'row-actions' },
      iconButton('edit', 'Rename', (event) => {
        event.stopPropagation();
        edit('pin', pin.id);
      }),
      iconButton('close', 'Unpin', (event) => {
        event.stopPropagation();
        run('unpin', { pinId: pin.id });
      }, 'danger')));

  draggable(row, { kind: 'pin', id: pin.id });
  dropTarget(row, {
    accepts: (item) => item.kind === 'pin' && item.id !== pin.id,
    ondrop: (item, side) => movePin(item.id, pin.folderId, pin.id, side),
  });
  return row;
}

function urlRow(folder) {
  return h('li', { class: 'pin adding' },
    icon('link'),
    editor({
      value: '',
      placeholder: 'https://…',
      label: 'Address to pin',
      onsave: (value) => {
        const text = value.trim();
        if (!text) return render();
        const url = /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
        return run('add-pin', { url, folderId: folder.id });
      },
    }));
}

function palette(folder) {
  return h('div', { class: 'palette', role: 'group', 'aria-label': 'Folder colour' },
    state.colors.map((color) => h('button', {
      class: `swatch ${color === folder.color ? 'selected' : ''}`,
      type: 'button',
      title: color,
      'aria-label': color,
      style: `--swatch: ${GROUP_COLORS[color]}`,
      onclick: () => {
        ui.palette = null;
        run('update-folder', { folderId: folder.id, color });
      },
    })));
}

function folderSection(folder) {
  const pins = state.model.pins.filter((p) => p.folderId === folder.id);
  const canPinHere = !isPage && state.current?.pinnable && !state.current.pinId;

  const head = h('div', { class: 'folder-head' },
    h('button', {
      class: 'swatch', type: 'button', title: 'Change colour', 'aria-label': 'Change colour',
      style: `--swatch: ${GROUP_COLORS[folder.color]}`,
      onclick: () => {
        ui.palette = ui.palette === folder.id ? null : folder.id;
        render();
      },
    }),
    isEditing('folder', folder.id)
      ? editor({
        value: folder.title,
        placeholder: 'Folder name',
        label: 'Folder name',
        onsave: (title) => run('update-folder', { folderId: folder.id, title }),
      })
      : h('h2', { class: 'grow', ondblclick: () => edit('folder', folder.id) },
        folder.title || h('em', {}, 'Untitled folder'),
        h('small', {}, String(pins.length))),
    h('span', { class: 'row-actions' },
      canPinHere && iconButton('pin', 'Super pin this tab here', () =>
        run('pin-tab', { tabId: state.current.tabId, folderId: folder.id })),
      iconButton('link', 'Pin an address', () => {
        ui.adding = { kind: 'url', id: folder.id };
        render();
      }),
      iconButton('edit', 'Rename folder', () => edit('folder', folder.id)),
      iconButton('trash', pins.length ? `Delete folder and unpin its ${pins.length}` : 'Delete folder', () => {
        if (pins.length && !confirm(`Delete “${folder.title || 'Untitled folder'}” and unpin the ${pins.length} in it?`)) return;
        run('delete-folder', { folderId: folder.id });
      }, 'danger')));

  const section = h('section', { class: 'card folder' },
    head,
    ui.palette === folder.id && palette(folder),
    h('ul', {},
      pins.map(pinRow),
      ui.adding?.kind === 'url' && ui.adding.id === folder.id && urlRow(folder),
      !pins.length && ui.adding?.id !== folder.id && h('li', { class: 'empty' }, 'Nothing pinned here yet.')));

  draggable(head, { kind: 'folder', id: folder.id });
  dropTarget(head, {
    accepts: (item) => item.kind === 'pin',
    into: true,
    ondrop: (item) => movePin(item.id, folder.id, null, 'into'),
  });
  dropTarget(section, {
    accepts: (item) => item.kind === 'folder' && item.id !== folder.id,
    ondrop: (item, side) => moveFolder(item.id, folder.id, side),
  });
  return section;
}

function newFolderCard() {
  return h('section', { class: 'card folder' },
    h('div', { class: 'folder-head' },
      icon('folder'),
      editor({
        value: '',
        placeholder: 'Folder name',
        label: 'Folder name',
        onsave: (title) => (title.trim() ? run('add-folder', { title }) : render()),
      })));
}

function emptyState() {
  return h('section', { class: 'card empty-state' },
    h('strong', {}, 'No super pins yet'),
    h('p', {}, isPage
      ? 'Open a page, click the Super Pins button in the toolbar, and choose “Super pin this tab”.'
      : 'Pin this tab, and it will be waiting in every window, every time you open Helium.'));
}

function trashSection() {
  const { trash } = state.model;
  if (!trash.length) return null;
  return h('details', {
    class: 'card', open: isPage || ui.trash,
    ontoggle: (event) => { ui.trash = event.target.open; },
  },
    h('summary', {}, icon('chevron'), 'Recently unpinned', h('small', {}, String(trash.length))),
    h('ul', {}, trash.map((item) => h('li', { class: 'pin', title: item.url },
      h('img', { class: 'favicon', src: faviconOf(item), alt: '' }),
      h('span', { class: 'name grow' }, pinName(item), h('small', {}, item.folderTitle || hostOf(item.url))),
      h('span', { class: 'row-actions shown' },
        iconButton('restore', 'Pin again', () => run('restore', { trashId: item.id })))))),
    h('div', { class: 'actions end' },
      h('button', { class: 'button', type: 'button', onclick: () => run('empty-trash') }, 'Clear list')));
}

const SETTINGS = [
  ['dragToPin', 'Drag in to pin', 'Dropping a tab into a super-pin group pins it.'],
  ['dragToUnpin', 'Drag out to unpin', 'Dragging a super pin out of its group unpins it.'],
  ['externalLinks', 'Keep pins on their site', 'Links from a pinned page to another site open in a new tab.'],
];

function settingsSection() {
  const { settings } = state.model;
  return h('details', {
    class: 'card', open: isPage || ui.settings,
    ontoggle: (event) => { ui.settings = event.target.open; },
  },
    h('summary', {}, icon('chevron'), 'Settings'),
    SETTINGS.map(([key, title, hint]) => h('label', { class: 'setting' },
      h('span', {}, h('strong', {}, title), h('small', {}, hint)),
      h('input', {
        type: 'checkbox', checked: settings[key],
        onchange: (event) => run('set-settings', { settings: { [key]: event.target.checked } }),
      }))),
    h('div', { class: 'actions end' },
      h('button', {
        class: 'button', type: 'button',
        onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
      }, 'Keyboard shortcuts'),
      isPage && h('button', { class: 'button', type: 'button', onclick: exportPins }, 'Export'),
      isPage && h('button', { class: 'button', type: 'button', onclick: importPins }, 'Import')));
}

function exportPins() {
  const { folders, pins, settings } = state.model;
  const blob = new Blob([JSON.stringify({ version: 1, folders, pins, settings }, null, 2)], { type: 'application/json' });
  const link = h('a', { href: URL.createObjectURL(blob), download: 'super-pins.json' });
  link.click();
  URL.revokeObjectURL(link.href);
}

function importPins() {
  const input = h('input', {
    type: 'file', accept: 'application/json,.json',
    onchange: async () => {
      const [file] = input.files;
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
        if (!Array.isArray(data?.folders) || !Array.isArray(data?.pins)) throw new Error('not a Super Pins export');
      } catch (error) {
        ui.error = `Couldn't read that file: ${error.message}`;
        render();
        return;
      }
      const count = state.model.pins.length;
      if (count && !confirm(`Replace your ${count} super pins with the ${data.pins.length} in this file?`)) return;
      run('import', { data: { ...data, trash: state.model.trash } });
    },
  });
  input.click();
}

function render() {
  const { folders } = state.model;
  const scroll = document.scrollingElement.scrollTop;
  app.replaceChildren(...[
    header(),
    ui.error && h('p', { class: 'error', role: 'alert' }, ui.error),
    currentCard(),
    ui.adding?.kind === 'folder' && newFolderCard(),
    ...folders.map(folderSection),
    !folders.length && ui.adding?.kind !== 'folder' && emptyState(),
    trashSection(),
    settingsSection(),
  ].filter(Boolean));
  document.scrollingElement.scrollTop = scroll;
}

// ---------------------------------------------------------------- start

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  here = { tabId: tab?.id ?? null, windowId: tab?.windowId ?? null };

  const rename = location.hash.match(/^#rename=(.+)$/);
  if (rename) ui.editing = { kind: 'pin', id: rename[1] };

  await refresh();

  // Pins change from the tab strip too; keep up unless the user is mid-edit.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.model && !ui.editing && !ui.adding && !drag) refresh();
  });
}

start().catch((error) => {
  app.replaceChildren(h('p', { class: 'error', role: 'alert' }, `Super Pins couldn't start: ${error.message}`));
});
