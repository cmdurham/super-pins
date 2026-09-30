// Persistent model (chrome.storage.local) and per-browser-session runtime maps
// (chrome.storage.session). Only the service worker writes either of them; the
// popup and the placeholder pages read the model and ask the worker for changes.

export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export const DEFAULT_SETTINGS = {
  dragToPin: true,       // dropping a tab into a super-pin group pins it
  dragToUnpin: true,     // dragging a super pin out of its group unpins it
  externalLinks: true,   // links to other sites open in a new tab instead of replacing the pin
};

export const DEFAULT_FOLDER_TITLE = 'Pins';
export const TRASH_LIMIT = 20;

const blankModel = () => ({ version: 1, folders: [], pins: [], trash: [], settings: { ...DEFAULT_SETTINGS } });
// instances: tabId -> { pinId, windowId, placed }   one tab per pin per window
// groups:    groupId -> { folderId, windowId }      one tab group per folder per window
// windows:   windowId -> { synced, fails, failedAt }
const blankRuntime = () => ({ instances: {}, groups: {}, windows: {} });

let model = null;
let runtime = null;

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback);

export function normalizeModel(raw) {
  const out = blankModel();
  if (!raw || typeof raw !== 'object') return out;

  const seen = new Set();
  const uniqueId = (id) => {
    const value = str(id) && !seen.has(id) ? id : newId();
    seen.add(value);
    return value;
  };

  for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
    if (!f || typeof f !== 'object') continue;
    out.folders.push({
      id: uniqueId(f.id),
      title: str(f.title),
      color: COLORS.includes(f.color) ? f.color : 'grey',
      collapsed: Boolean(f.collapsed),
    });
  }

  const folderIds = new Set(out.folders.map((f) => f.id));
  const cleanPin = (p) => ({
    id: uniqueId(p.id),
    folderId: p.folderId,
    url: p.url,
    title: str(p.title) || null,       // the user's name for the pin
    pageTitle: str(p.pageTitle),       // the page's own title, used until the pin is renamed
    favicon: str(p.favicon) || null,   // data: URL
    faviconSrc: str(p.faviconSrc) || null,
  });
  for (const p of Array.isArray(raw.pins) ? raw.pins : []) {
    if (!p || typeof p !== 'object' || !str(p.url) || !folderIds.has(p.folderId)) continue;
    out.pins.push(cleanPin(p));
  }
  for (const p of Array.isArray(raw.trash) ? raw.trash : []) {
    if (!p || typeof p !== 'object' || !str(p.url)) continue;
    out.trash.push({ ...cleanPin(p), folderTitle: str(p.folderTitle), removedAt: Number(p.removedAt) || 0 });
  }
  out.trash.length = Math.min(out.trash.length, TRASH_LIMIT);

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof raw.settings?.[key] === 'boolean') out.settings[key] = raw.settings[key];
  }
  return out;
}

export async function getModel() {
  if (!model) model = normalizeModel((await chrome.storage.local.get('model')).model);
  return model;
}

export async function saveModel() {
  await chrome.storage.local.set({ model });
}

export async function replaceModel(raw) {
  model = normalizeModel(raw);
  await saveModel();
  return model;
}

export async function getRuntime() {
  if (!runtime) {
    const stored = (await chrome.storage.session.get('runtime')).runtime;
    runtime = { ...blankRuntime(), ...(stored && typeof stored === 'object' ? stored : {}) };
  }
  return runtime;
}

export async function saveRuntime() {
  await chrome.storage.session.set({ runtime });
}

// Every change to the model or to the tab strip runs through this queue, so an
// event that arrives while a sync is in flight waits for it instead of racing it.
// A job that hangs on a browser call is abandoned after a while rather than
// holding up everything behind it.
const JOB_TIMEOUT_MS = 15000;

let chain = Promise.resolve();
export function enqueue(job) {
  const run = chain.then(() => {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('sync timed out')), JOB_TIMEOUT_MS);
    });
    return Promise.race([Promise.resolve().then(job), timeout]).finally(() => clearTimeout(timer));
  });
  chain = run.catch(() => {});
  return run;
}
