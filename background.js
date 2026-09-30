import { COLORS, DEFAULT_SETTINGS, enqueue, getModel, getRuntime, replaceModel, saveModel, saveRuntime } from './store.js';
import * as engine from './engine.js';

const SETTLE_MS = 400;        // quiet time after the last tab event before acting on it
const DRAG_RETRY_MS = 500;
const STARTUP_MS = 1500;      // let session restore finish putting tabs back

// ---------------------------------------------------------------- scheduling

const timers = new Map();

function schedule(windowId, delay = SETTLE_MS) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;
  clearTimeout(timers.get(windowId));
  timers.set(windowId, setTimeout(() => {
    timers.delete(windowId);
    enqueue(() => engine.settle(windowId)).then(refreshMenus, (error) => {
      if (engine.isDragError(error)) schedule(windowId, DRAG_RETRY_MS);
      else console.warn('[super-pins]', error);
    });
  }, delay));
}

async function scheduleAll(delay) {
  for (const windowId of await engine.normalWindowIds()) schedule(windowId, delay);
}

engine.onRetry((windowId) => schedule(windowId, DRAG_RETRY_MS));

// Run a model edit, save it, and bring every window in line with it.
function commit(edit) {
  return enqueue(async () => {
    const [model, rt] = [await getModel(), await getRuntime()];
    const result = await edit(model, rt);
    await saveModel();
    await engine.reconcileAll();
    engine.applyPageScriptEverywhere();
    return result;
  }).finally(refreshMenus);
}

// ---------------------------------------------------------------- actions

async function normalWindowTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  if (win.type !== 'normal' || win.incognito) throw new Error('Super pins only live in regular windows.');
  return tab;
}

async function pinTab(tabId, folderId) {
  const tab = await normalWindowTab(tabId);
  if (!engine.isPinnable(tab)) throw new Error("This page can't be pinned.");
  const pin = await commit(() => engine.pinTab(tab, folderId));
  if (pin) engine.captureFavicon(pin.id, tab.favIconUrl, pin.url);
  return pin;
}

const unpin = (pinId) => commit((model, rt) => engine.removePin(model, rt, pinId));

async function togglePin(tab) {
  if (!tab) return;
  const pin = await engine.pinForTab(tab.id);
  if (pin) await unpin(pin.id);
  else await pinTab(tab.id);
}

const renamePin = (pinId, title) => commit((model) => {
  const pin = engine.pinById(model, pinId);
  if (pin) pin.title = String(title ?? '').trim() || null;
});

async function resetPin(tabId) {
  const pin = await engine.pinForTab(tabId);
  if (pin) await chrome.tabs.update(tabId, { url: pin.url });
}

async function useCurrentUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const pin = await engine.pinForTab(tabId);
  if (!pin || !engine.isPinnable(tab)) return;
  await commit((model) => {
    const target = engine.pinById(model, pin.id);
    target.url = tab.url;
    if (!target.title && tab.title) target.pageTitle = tab.title;
  });
  engine.captureFavicon(pin.id, tab.favIconUrl, tab.url);
}

async function promptRename(tab) {
  const pin = tab && await engine.pinForTab(tab.id);
  if (!pin) return;
  let answer;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (current) => prompt('Name for this super pin (leave empty to use the page title):', current),
      args: [pin.title ?? ''],
    });
    answer = injection.result;
  } catch {
    // Pages that can't be scripted: rename from the manager instead.
    await openManager(`#rename=${pin.id}`);
    return;
  }
  if (answer != null) await renamePin(pin.id, answer);
}

function openManager(hash = '') {
  return chrome.tabs.create({ url: chrome.runtime.getURL(`options.html${hash}`) });
}

async function openPin(pinId, windowId) {
  const rt = await getRuntime();
  const entry = Object.entries(rt.instances).find(([, inst]) => inst.pinId === pinId && inst.windowId === windowId);
  if (!entry) return;
  await chrome.tabs.update(Number(entry[0]), { active: true });
}

async function restorePin(trashId) {
  const pin = await commit((model) => {
    const item = model.trash.find((t) => t.id === trashId);
    if (!item) return null;
    model.trash = model.trash.filter((t) => t.id !== trashId);
    const folder = engine.folderById(model, item.folderId)
      ?? model.folders.find((f) => f.title === item.folderTitle)
      ?? (item.folderTitle ? engine.addFolder(model, item.folderTitle) : null);
    return engine.addPin(model, item, folder?.id);
  });
  return pin;
}

async function openExternal(url, sender) {
  if (!sender.tab || !/^https?:/i.test(url)) return;
  const pin = await engine.pinForTab(sender.tab.id);
  if (!pin) return;
  const [model, tabs] = [await getModel(), await chrome.tabs.query({ windowId: sender.tab.windowId })];
  const tab = await chrome.tabs.create({
    url,
    windowId: sender.tab.windowId,
    openerTabId: sender.tab.id,
    index: tabs.filter((t) => t.pinned).length + model.pins.length,
    active: true,
  });
  engine.noteCreated(tab.id);
}

async function getState({ tabId, windowId }) {
  const [model, rt] = [await getModel(), await getRuntime()];
  const live = {};
  if (windowId != null) {
    for (const [key, inst] of Object.entries(rt.instances)) {
      if (inst.windowId !== windowId) continue;
      const tab = await chrome.tabs.get(Number(key)).catch(() => null);
      if (tab) live[inst.pinId] = { loaded: !engine.placeholderPinId(tab), active: tab.active };
    }
  }
  let current = null;
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab) {
    const pin = await engine.pinForTab(tab.id);
    current = {
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title,
      url: tab.url,
      pinId: pin?.id ?? null,
      pinnable: engine.isPinnable(tab),
      away: Boolean(pin) && !engine.placeholderPinId(tab) && tab.url !== pin.url,
    };
  }
  return { model, live, current, colors: COLORS };
}

const actions = {
  'get-state': (m) => getState(m),
  'pin-tab': (m) => pinTab(m.tabId, m.folderId),
  'unpin': (m) => unpin(m.pinId),
  'rename-pin': (m) => renamePin(m.pinId, m.title),
  'reset-pin': (m) => resetPin(m.tabId),
  'use-current-url': (m) => useCurrentUrl(m.tabId),
  'open-pin': (m) => openPin(m.pinId, m.windowId),
  'restore': (m) => restorePin(m.trashId),
  'sync': async () => {
    for (const windowId of await engine.normalWindowIds()) {
      await enqueue(() => engine.settle(windowId, { force: true })).catch(() => schedule(windowId, DRAG_RETRY_MS));
    }
  },

  'add-pin': async (m) => {
    const url = new URL(m.url).href;
    const pin = await commit((model) => engine.addPin(model, { url, title: String(m.title ?? '').trim() || null }, m.folderId));
    engine.captureFavicon(pin.id, null, url);
    return pin;
  },
  'set-pin-url': (m) => {
    const url = new URL(m.url).href;
    return commit((model) => {
      const pin = engine.pinById(model, m.pinId);
      if (pin) pin.url = url;
    });
  },
  'move-pin': (m) => commit((model) => engine.placePin(model, m.pinId, m.folderId, m.index)),
  'add-folder': (m) => commit((model) => engine.addFolder(model, String(m.title ?? '').trim(), m.color)),
  'update-folder': (m) => commit((model) => {
    const folder = engine.folderById(model, m.folderId);
    if (!folder) return;
    if (typeof m.title === 'string') folder.title = m.title.trim();
    if (COLORS.includes(m.color)) folder.color = m.color;
  }),
  'move-folder': (m) => commit((model) => engine.placeFolder(model, m.folderId, m.index)),
  'delete-folder': (m) => commit(async (model, rt) => {
    for (const pin of engine.pinsIn(model, m.folderId)) await engine.removePin(model, rt, pin.id);
    model.folders = model.folders.filter((f) => f.id !== m.folderId);
  }),
  'empty-trash': () => commit((model) => { model.trash = []; }),
  'set-settings': (m) => commit((model) => {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof m.settings?.[key] === 'boolean') model.settings[key] = m.settings[key];
    }
  }),
  'import': (m) => enqueue(async () => {
    await replaceModel(m.data);
    await engine.reconcileAll();
    engine.applyPageScriptEverywhere();
  }),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  // Pinned pages can only ask for one thing; everything else is for our own pages.
  const ours = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  let job;
  if (type === 'open-external') job = openExternal(String(message.url ?? ''), sender);
  else if (ours && Object.hasOwn(actions, type)) job = Promise.resolve().then(() => actions[type](message));
  else return false;

  job.then(
    (result) => sendResponse({ ok: true, result: result ?? null }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true;
});

// ---------------------------------------------------------------- menus and shortcuts

const PIN_ONLY_MENUS = ['reset', 'use-current', 'rename'];

// Install, startup and a plain worker start can all ask for the menus at once.
let menuTimer = null;
function createMenus() {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => chrome.contextMenus.removeAll(() => {
    const add = (id, title) => chrome.contextMenus.create({ id, title, contexts: ['page'] });
    add('toggle', 'Super pin this tab');
    add('reset', 'Back to pinned page');
    add('use-current', 'Pin this page instead');
    add('rename', 'Rename super pin…');
    chrome.contextMenus.create({ id: 'separator', type: 'separator', contexts: ['page'] });
    add('manage', 'Manage super pins…');
    refreshMenus();
  }), 50);
}

async function refreshMenus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const pin = tab ? await engine.pinForTab(tab.id) : null;
    await chrome.contextMenus.update('toggle', { title: pin ? 'Remove super pin' : 'Super pin this tab' });
    for (const id of PIN_ONLY_MENUS) await chrome.contextMenus.update(id, { visible: Boolean(pin) });
  } catch {
    // Menus not created yet.
  }
}

const report = (error) => console.warn('[super-pins]', error);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const run = {
    toggle: () => togglePin(tab),
    reset: () => resetPin(tab.id),
    'use-current': () => useCurrentUrl(tab.id),
    rename: () => promptRename(tab),
    manage: () => openManager(),
  }[info.menuItemId];
  if (run) Promise.resolve().then(run).catch(report);
});

chrome.commands.onCommand.addListener((command, tab) => {
  const run = {
    'toggle-super-pin': () => togglePin(tab),
    'reset-super-pin': () => resetPin(tab.id),
    'rename-super-pin': () => promptRename(tab),
    'update-super-pin-url': () => useCurrentUrl(tab.id),
  }[command];
  if (run && tab) Promise.resolve().then(run).catch(report);
});

// ---------------------------------------------------------------- browser events

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  scheduleAll(300);
});

// Turning the extension off and on again fires neither of the events around
// this, but it does start the worker with nothing remembered about any window.
getRuntime().then((rt) => {
  if (Object.keys(rt.windows).length) return;
  createMenus();
  scheduleAll(STARTUP_MS);
});

chrome.runtime.onStartup.addListener(() => {
  createMenus();
  scheduleAll(STARTUP_MS);
});

chrome.windows.onCreated.addListener((win) => {
  if (win.type === 'normal' && !win.incognito) schedule(win.id, SETTLE_MS * 2);
}, { windowTypes: ['normal'] });

chrome.windows.onRemoved.addListener((windowId) => {
  clearTimeout(timers.get(windowId));
  timers.delete(windowId);
  enqueue(async () => {
    const rt = await getRuntime();
    delete rt.windows[windowId];
    for (const [key, inst] of Object.entries(rt.instances)) if (inst.windowId === windowId) delete rt.instances[key];
    for (const [key, entry] of Object.entries(rt.groups)) if (entry.windowId === windowId) delete rt.groups[key];
    await saveRuntime();
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  engine.noteCreated(tab.id);
  schedule(tab.windowId);
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (!info.isWindowClosing) schedule(info.windowId);
});

chrome.tabs.onMoved.addListener((tabId, info) => schedule(info.windowId));
chrome.tabs.onDetached.addListener((tabId, info) => schedule(info.oldWindowId));
chrome.tabs.onAttached.addListener((tabId, info) => schedule(info.newWindowId));

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueue(async () => {
    const rt = await getRuntime();
    if (!rt.instances[removedTabId]) return;
    rt.instances[addedTabId] = rt.instances[removedTabId];
    delete rt.instances[removedTabId];
    await saveRuntime();
    engine.applyPageScript(addedTabId);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  refreshMenus();
  wake(tabId);
});

// Dormant pins listen for this and load once their tab is the selected one.
async function wake(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && engine.placeholderPinId(tab)) chrome.runtime.sendMessage({ type: 'wake' }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ('groupId' in change || 'pinned' in change) schedule(tab.windowId);
  if (change.status === 'complete' || change.favIconUrl) refreshMeta(tab).catch(report);
  if (change.status === 'complete' && tab.active) refreshMenus();
});

// Keep a pin's icon and fallback title fresh while its tab is on the pinned site.
async function refreshMeta(tab) {
  const pin = await engine.pinForTab(tab.id);
  if (!pin || engine.placeholderPinId(tab)) return;
  let sameHost = false;
  try {
    sameHost = new URL(tab.url).hostname === new URL(pin.url).hostname;
  } catch {
    return;
  }
  if (!sameHost) return;

  if (tab.favIconUrl && tab.favIconUrl !== pin.faviconSrc) engine.captureFavicon(pin.id, tab.favIconUrl, pin.url);
  if (tab.status === 'complete' && !pin.title && tab.title && tab.title !== pin.pageTitle) {
    await enqueue(async () => {
      const target = engine.pinById(await getModel(), pin.id);
      if (!target || target.title) return;
      target.pageTitle = tab.title;
      await saveModel();
    });
  }
}

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) engine.applyPageScript(details.tabId);
});

for (const event of [chrome.tabGroups.onUpdated, chrome.tabGroups.onMoved, chrome.tabGroups.onRemoved]) {
  event.addListener((group) => schedule(group.windowId));
}

// For poking at things from the service worker console.
globalThis.superPins = { actions, enqueue, engine, getModel, getRuntime, schedule, scheduleAll };
