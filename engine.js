// Keeps every window's tab strip in step with the saved pins.
//
//   folder  <->  one tab group per window, first thing after the native pinned tabs
//   pin     <->  one tab per window inside that group: a dormant placeholder page
//                (pin.html#<id>) until it's first shown, the real page afterwards
//
// reconcileWindow() pushes the model into a window. interpret() goes the other
// way: it reads what the user did in the tab strip (dragged a tab in or out of a
// group, reordered, renamed a group) and folds that into the model.

import {
  COLORS, DEFAULT_FOLDER_TITLE, TRASH_LIMIT,
  enqueue, getModel, getRuntime, saveModel, saveRuntime, newId,
} from './store.js';
import { pageScript } from './page-script.js';

const PLACEHOLDER = chrome.runtime.getURL('pin.html');
const RECENT_MS = 4000;
const MAX_FAILS = 3;
const FAIL_COOLDOWN_MS = 30000;
const FAVICON_MAX_BYTES = 200000;

export const placeholderUrl = (pinId) => `${PLACEHOLDER}#${pinId}`;

export function placeholderPinId(tab) {
  const url = tab.url || tab.pendingUrl || '';
  return url.startsWith(PLACEHOLDER) ? url.slice(PLACEHOLDER.length).replace(/^#/, '') : null;
}

const tabUrl = (tab) => tab.url || tab.pendingUrl || '';

export function isPinnable(tab) {
  const url = tabUrl(tab);
  if (!url || url.startsWith(chrome.runtime.getURL(''))) return false;
  return !/^(about:blank|chrome:\/\/(newtab|new-tab-page)|helium:\/\/(newtab|new-tab-page))/.test(url);
}

export const isDragError = (error) => /dragging|cannot be edited right now/i.test(String(error?.message ?? error));

// Tabs that Chromium itself drops into a group (a link opened from a grouped
// tab, "Duplicate", "New tab to the right") are brand new; a tab the user drags
// in is not. That difference is how the two are told apart.
const created = new Map();
export function noteCreated(tabId) {
  const now = Date.now();
  created.set(tabId, now);
  for (const [id, at] of created) if (now - at > RECENT_MS * 4) created.delete(id);
}
const isRecent = (tabId) => Date.now() - (created.get(tabId) ?? 0) < RECENT_MS;

let retryHandler = () => {};
export const onRetry = (handler) => { retryHandler = handler; };

// ---------------------------------------------------------------- lookups

export const pinsIn = (model, folderId) => model.pins.filter((p) => p.folderId === folderId);
export const pinById = (model, id) => model.pins.find((p) => p.id === id);
export const folderById = (model, id) => model.folders.find((f) => f.id === id);

function instancesIn(rt, windowId) {
  const map = new Map();
  for (const [tabId, inst] of Object.entries(rt.instances)) {
    if (inst.windowId === windowId) map.set(inst.pinId, Number(tabId));
  }
  return map;
}

function groupFor(rt, windowId, folderId) {
  for (const [groupId, entry] of Object.entries(rt.groups)) {
    if (entry.windowId === windowId && entry.folderId === folderId) return Number(groupId);
  }
  return null;
}

function managedFolderId(rt, windowId, groupId) {
  const entry = rt.groups[groupId];
  return entry && entry.windowId === windowId ? entry.folderId : null;
}

export async function normalWindowIds() {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return windows.filter((w) => !w.incognito).map((w) => w.id);
}

export async function pinForTab(tabId) {
  const [model, rt] = await Promise.all([getModel(), getRuntime()]);
  const inst = rt.instances[tabId];
  return inst ? pinById(model, inst.pinId) ?? null : null;
}

async function snapshot(windowId) {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);
  tabs.sort((a, b) => a.index - b.index);
  return { tabs, groups };
}

// Reduce a hostname to its registrable domain, near enough (see page-script.js).
function site(hostname) {
  const labels = hostname.toLowerCase().split('.');
  if (labels.length <= 2 || /^[\d.]+$/.test(hostname)) return hostname.toLowerCase();
  const generic = ['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'].includes(labels.at(-2)) && labels.at(-1).length === 2;
  return labels.slice(generic ? -3 : -2).join('.');
}

function siteOf(url) {
  try {
    return site(new URL(url).hostname);
  } catch {
    return null;
  }
}

const sameArray = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

// ---------------------------------------------------------------- page script

export async function applyPageScript(tabId) {
  const [model, pin] = [await getModel(), await pinForTab(tabId)];
  if (!pin) return;
  await injectPageScript(tabId, { name: pin.title, home: pin.url, intercept: model.settings.externalLinks });
}

// Never awaited from inside the queue: on a tab that hasn't committed a page
// yet, executeScript doesn't settle until it does.
async function injectPageScript(tabId, cfg) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^(https?|file):/i.test(tab.url ?? '')) return;
    await chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: pageScript,
      args: [cfg],
    });
  } catch {
    // Pages that can't be scripted (the extension store, the PDF viewer).
  }
}

export async function applyPageScriptEverywhere() {
  const rt = await getRuntime();
  for (const tabId of Object.keys(rt.instances)) applyPageScript(Number(tabId));
}

// ---------------------------------------------------------------- favicons

async function toDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`favicon ${response.status}`);
  const blob = await response.blob();
  if (!blob.size || blob.size > FAVICON_MAX_BYTES) throw new Error('favicon size');
  let binary = '';
  for (const byte of new Uint8Array(await blob.arrayBuffer())) binary += String.fromCharCode(byte);
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

const faviconApiUrl = (pageUrl) =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);

// Network work, so it runs outside the queue. Returns a data: URL or null.
export async function fetchFavicon(favIconUrl, pageUrl) {
  if (favIconUrl?.startsWith('data:')) return favIconUrl.length <= FAVICON_MAX_BYTES * 1.4 ? favIconUrl : null;
  if (/^https?:/.test(favIconUrl ?? '')) {
    const data = await toDataUrl(favIconUrl).catch(() => null);
    if (data) return data;
  }
  return toDataUrl(faviconApiUrl(pageUrl)).catch(() => null);
}

export async function captureFavicon(pinId, favIconUrl, pageUrl) {
  const data = await fetchFavicon(favIconUrl, pageUrl);
  if (!data) return;
  await enqueue(async () => {
    const pin = pinById(await getModel(), pinId);
    if (!pin || pin.favicon === data) return;
    pin.favicon = data;
    pin.faviconSrc = favIconUrl || null;
    await saveModel();
  });
}

// Pins made by dragging a tab into a group get their favicon once the sync is done.
const pendingFavicons = [];
function flushFavicons() {
  for (const { pinId, src, url } of pendingFavicons.splice(0)) captureFavicon(pinId, src, url);
}

// ---------------------------------------------------------------- model edits
// These only touch the model and the runtime maps (plus the tabs of a removed
// pin). Callers save and reconcile afterwards.

export function ensureFolder(model, folderId) {
  const existing = folderById(model, folderId) ?? model.folders[0];
  if (existing) return existing;
  return addFolder(model, DEFAULT_FOLDER_TITLE);
}

export function addFolder(model, title, color) {
  const used = new Set(model.folders.map((f) => f.color));
  const folder = {
    id: newId(),
    title: title ?? '',
    color: COLORS.includes(color) ? color : COLORS.find((c) => c !== 'grey' && !used.has(c)) ?? 'blue',
    collapsed: false,
  };
  model.folders.push(folder);
  return folder;
}

export function addPin(model, { url, pageTitle = '', title = null, favicon = null, faviconSrc = null }, folderId, index) {
  const folder = ensureFolder(model, folderId);
  const pin = { id: newId(), folderId: folder.id, url, title, pageTitle, favicon, faviconSrc };
  model.pins.push(pin);
  if (Number.isInteger(index)) placePin(model, pin.id, folder.id, index);
  return pin;
}

// Move a pin to position `index` within `folderId`.
export function placePin(model, pinId, folderId, index) {
  const pin = pinById(model, pinId);
  if (!pin || !folderById(model, folderId)) return false;
  const siblings = pinsIn(model, folderId).filter((p) => p.id !== pinId);
  const at = Math.max(0, Math.min(index, siblings.length));
  pin.folderId = folderId;
  model.pins = model.pins.filter((p) => p.id !== pinId);
  const before = siblings[at];
  const insertAt = before ? model.pins.indexOf(before) : model.pins.length;
  model.pins.splice(insertAt, 0, pin);
  return true;
}

export function placeFolder(model, folderId, index) {
  const folder = folderById(model, folderId);
  if (!folder) return false;
  model.folders = model.folders.filter((f) => f.id !== folderId);
  model.folders.splice(Math.max(0, Math.min(index, model.folders.length)), 0, folder);
  return true;
}

// Put the pins of a folder in the order seen in a window. Pins the window
// doesn't show (a tab that was just closed) keep their slot.
function reorderPins(model, folderId, orderedIds) {
  const inFolder = pinsIn(model, folderId);
  const seen = orderedIds.filter((id) => inFolder.some((p) => p.id === id));
  let next = 0;
  const sorted = inFolder.map((p) => (seen.includes(p.id) ? pinById(model, seen[next++]) : p));
  if (sameArray(sorted, inFolder)) return false;
  next = 0;
  model.pins = model.pins.map((p) => (p.folderId === folderId ? sorted[next++] : p));
  return true;
}

// Removes the pin and deals with its tabs: dormant placeholders are closed,
// loaded pages are left open as ordinary tabs.
export async function removePin(model, rt, pinId, { toTrash = true } = {}) {
  const pin = pinById(model, pinId);
  if (!pin) return false;
  model.pins = model.pins.filter((p) => p.id !== pinId);
  if (toTrash) {
    const { id, folderId, ...rest } = pin;
    model.trash.unshift({
      id: newId(), ...rest, folderId,
      folderTitle: folderById(model, folderId)?.title ?? '',
      removedAt: Date.now(),
    });
    model.trash.length = Math.min(model.trash.length, TRASH_LIMIT);
  }

  for (const [key, inst] of Object.entries(rt.instances)) {
    if (inst.pinId !== pinId) continue;
    delete rt.instances[key];
    const tabId = Number(key);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    if (placeholderPinId(tab)) {
      await chrome.tabs.remove(tabId).catch(() => {});
    } else {
      await chrome.tabs.ungroup(tabId).catch(() => {});
      injectPageScript(tabId, null);
    }
  }
  return true;
}

// Turn an open tab into a pin. The tab itself becomes the pin's tab in its window.
export async function pinTab(tab, folderId) {
  const [model, rt] = [await getModel(), await getRuntime()];
  if (rt.instances[tab.id] && pinById(model, rt.instances[tab.id].pinId)) return pinById(model, rt.instances[tab.id].pinId);
  if (!isPinnable(tab)) return null;

  const pin = addPin(model, { url: tabUrl(tab), pageTitle: tab.title ?? '' }, folderId);
  if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: false });
  rt.instances[tab.id] = { pinId: pin.id, windowId: tab.windowId, placed: false };
  return pin;
}

// ---------------------------------------------------------------- reading the tab strip

// Fold the user's tab-strip edits in `windowId` into the model.
// Returns true when the model changed and the other windows need to follow.
async function interpret(windowId) {
  const [model, rt] = [await getModel(), await getRuntime()];
  const { tabs, groups } = await snapshot(windowId);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  let changed = false;
  let touched = false;

  // Renaming or recolouring a group renames or recolours the folder.
  for (const [key, entry] of Object.entries(rt.groups)) {
    if (entry.windowId !== windowId) continue;
    const group = groupById.get(Number(key));
    const folder = folderById(model, entry.folderId);
    if (!group || !folder) continue;
    if ((group.title ?? '') !== folder.title || group.color !== folder.color) {
      folder.title = group.title ?? '';
      folder.color = group.color;
      changed = true;
    }
    if (group.collapsed !== folder.collapsed) {
      folder.collapsed = group.collapsed;
      touched = true;
    }
  }

  const present = instancesIn(rt, windowId);
  const strays = [];
  for (const tab of tabs) {
    let inst = rt.instances[tab.id];
    if (inst && (inst.windowId !== windowId || !pinById(model, inst.pinId))) {
      delete rt.instances[tab.id];
      inst = null;
    }
    const folderId = managedFolderId(rt, windowId, tab.groupId);
    const folder = folderId && folderById(model, folderId);

    if (!inst && folder) {
      const dormantId = placeholderPinId(tab);
      if (dormantId) {
        // A restored placeholder arriving late. Extras are closed by reconcile.
        if (pinById(model, dormantId) && !present.has(dormantId)) {
          rt.instances[tab.id] = { pinId: dormantId, windowId, placed: true };
          present.set(dormantId, tab.id);
        }
      } else if (model.settings.dragToPin && !isRecent(tab.id) && isPinnable(tab)) {
        const pin = addPin(model, { url: tabUrl(tab), pageTitle: tab.title ?? '' }, folder.id);
        rt.instances[tab.id] = { pinId: pin.id, windowId, placed: true };
        present.set(pin.id, tab.id);
        pendingFavicons.push({ pinId: pin.id, src: tab.favIconUrl, url: pin.url });
        changed = true;
      }
    } else if (inst && folder) {
      const pin = pinById(model, inst.pinId);
      if (pin.folderId !== folder.id) {
        pin.folderId = folder.id;
        changed = true;
      }
    } else if (inst && inst.placed) {
      strays.push({ tab, pin: pinById(model, inst.pinId) });
    }
  }

  // Pins that left their group. One at a time that's the user dragging a pin
  // out; a whole folder at once is "Ungroup" on the group, which is put back.
  const strayFolders = new Set(strays.map((s) => s.pin.folderId));
  for (const folderId of strayFolders) {
    const mine = strays.filter((s) => s.pin.folderId === folderId);
    const total = pinsIn(model, folderId).length;
    const dissolved = total >= 2 && mine.length === total;
    if (dissolved || !model.settings.dragToUnpin) continue;
    for (const { pin } of mine) {
      await removePin(model, rt, pin.id);
      changed = true;
    }
  }

  // Order of pins inside each folder, and of the folders themselves.
  const groupOrder = [];
  for (const folder of model.folders) {
    const groupId = groupFor(rt, windowId, folder.id);
    if (groupId == null) continue;
    const members = tabs.filter((t) => t.groupId === groupId && rt.instances[t.id]);
    if (!members.length) continue;
    groupOrder.push({ folderId: folder.id, index: members[0].index });
    if (reorderPins(model, folder.id, members.map((t) => rt.instances[t.id].pinId))) changed = true;
  }
  groupOrder.sort((a, b) => a.index - b.index);
  const seenOrder = groupOrder.map((g) => g.folderId);
  const modelOrder = model.folders.map((f) => f.id).filter((id) => seenOrder.includes(id));
  if (!sameArray(seenOrder, modelOrder)) {
    let next = 0;
    model.folders = model.folders.map((f) => (seenOrder.includes(f.id) ? folderById(model, seenOrder[next++]) : f));
    changed = true;
  }

  if (changed || touched) await saveModel();
  return changed;
}

// ---------------------------------------------------------------- writing the tab strip

function pruneRuntime(model, rt, windowId, tabs, groups) {
  const tabIds = new Set(tabs.map((t) => t.id));
  const groupIds = new Set(groups.map((g) => g.id));
  const taken = new Set();
  for (const [key, inst] of Object.entries(rt.instances)) {
    const tabId = Number(key);
    const here = inst.windowId === windowId;
    const stale = here ? !tabIds.has(tabId) : tabIds.has(tabId);
    const duplicate = here && taken.has(inst.pinId);
    if (stale || duplicate || !pinById(model, inst.pinId)) {
      delete rt.instances[key];
      // Still open but no longer a pin (it was dragged to another window).
      if (tabIds.has(tabId)) injectPageScript(tabId, null);
    } else if (here) {
      taken.add(inst.pinId);
    }
  }
  for (const [key, entry] of Object.entries(rt.groups)) {
    const groupId = Number(key);
    const here = entry.windowId === windowId;
    const stale = here ? !groupIds.has(groupId) : groupIds.has(groupId);
    if (stale || !folderById(model, entry.folderId)) delete rt.groups[key];
  }
}

// Pick the pin in `pins` that `tab` most plausibly is: same URL, else same site.
function matchPin(pins, tab) {
  const url = tabUrl(tab);
  const strip = (value) => value.replace(/#.*$/, '').replace(/\/$/, '');
  return pins.find((p) => strip(p.url) === strip(url))
    ?? pins.find((p) => siteOf(p.url) && siteOf(p.url) === siteOf(url))
    ?? null;
}

// After a restart (or a reload of the extension) tab and group ids are new.
// Recognise our tabs again: placeholders by their URL, loaded pins by sitting in
// a group named like the folder with a matching URL.
function adopt(model, rt, windowId, tabs, groups) {
  const present = instancesIn(rt, windowId);
  const surplus = [];

  for (const tab of tabs) {
    if (rt.instances[tab.id]) continue;
    const pinId = placeholderPinId(tab);
    if (!pinId) continue;
    if (pinById(model, pinId) && !present.has(pinId)) {
      rt.instances[tab.id] = { pinId, windowId, placed: false };
      present.set(pinId, tab.id);
    } else {
      surplus.push(tab.id);
    }
  }

  for (const folder of model.folders) {
    if (groupFor(rt, windowId, folder.id) != null) continue;
    const pins = pinsIn(model, folder.id);
    if (!pins.length) continue;
    const candidates = groups.filter((g) => !rt.groups[g.id] && (g.title ?? '') === folder.title);
    for (const group of candidates) {
      let matched = false;
      for (const tab of tabs.filter((t) => t.groupId === group.id)) {
        const inst = rt.instances[tab.id];
        if (inst) {
          matched ||= pinById(model, inst.pinId)?.folderId === folder.id;
          continue;
        }
        const pin = matchPin(pins.filter((p) => !present.has(p.id)), tab);
        if (!pin) continue;
        rt.instances[tab.id] = { pinId: pin.id, windowId, placed: false };
        present.set(pin.id, tab.id);
        matched = true;
      }
      if (matched) {
        rt.groups[group.id] = { folderId: folder.id, windowId };
        break;
      }
    }
  }
  return surplus;
}

function layoutOk(model, rt, windowId, tabs, groups) {
  let index = tabs.filter((t) => t.pinned).length;
  for (const folder of model.folders) {
    const pins = pinsIn(model, folder.id);
    if (!pins.length) continue;
    const groupId = groupFor(rt, windowId, folder.id);
    const group = groups.find((g) => g.id === groupId);
    if (!group || (group.title ?? '') !== folder.title || group.color !== folder.color) return false;
    for (const pin of pins) {
      const tab = tabs[index++];
      if (!tab || tab.groupId !== groupId || rt.instances[tab.id]?.pinId !== pin.id) return false;
    }
  }
  return !tabs.some((t) => managedFolderId(rt, windowId, t.groupId) && !rt.instances[t.id]);
}

async function arrange(model, rt, windowId) {
  let { tabs, groups } = await snapshot(windowId);

  // Anything in one of our groups that isn't a pin gets put out of it.
  const foreign = tabs.filter((t) => managedFolderId(rt, windowId, t.groupId) && !rt.instances[t.id]);
  if (foreign.length) await chrome.tabs.ungroup(foreign.map((t) => t.id));

  const present = instancesIn(rt, windowId);
  let index = tabs.filter((t) => t.pinned).length;

  for (const folder of model.folders) {
    const pins = pinsIn(model, folder.id);
    if (!pins.length) continue;
    const ids = pins.map((p) => present.get(p.id));
    ({ tabs, groups } = await snapshot(windowId));
    const tabById = new Map(tabs.map((t) => [t.id, t]));
    let groupId = groupFor(rt, windowId, folder.id);

    if (groupId == null) {
      groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      rt.groups[groupId] = { folderId: folder.id, windowId };
      const activeInside = ids.some((id) => tabById.get(id)?.active);
      await chrome.tabGroups.update(groupId, {
        title: folder.title,
        color: folder.color,
        collapsed: folder.collapsed && !activeInside,
      });
    } else {
      const loose = ids.filter((id) => tabById.get(id)?.groupId !== groupId);
      if (loose.length) await chrome.tabs.group({ tabIds: loose, groupId });
      const group = groups.find((g) => g.id === groupId);
      if ((group.title ?? '') !== folder.title || group.color !== folder.color) {
        await chrome.tabGroups.update(groupId, { title: folder.title, color: folder.color });
      }
    }

    ({ tabs } = await snapshot(windowId));
    const first = tabs.find((t) => t.groupId === groupId);
    if (first && first.index !== index) await chrome.tabGroups.move(groupId, { index });

    for (let i = 0; i < ids.length; i++) {
      let tab = await chrome.tabs.get(ids[i]);
      if (tab.index !== index + i) {
        await chrome.tabs.move(ids[i], { index: index + i });
        tab = await chrome.tabs.get(ids[i]);
      }
      if (tab.groupId !== groupId) await chrome.tabs.group({ tabIds: [ids[i]], groupId });
    }
    index += ids.length;
  }
}

// Make `windowId` show exactly the saved pins, creating dormant tabs for any
// that are missing. Does nothing at all when the window is already right.
export async function reconcileWindow(windowId) {
  const [model, rt] = [await getModel(), await getRuntime()];
  const state = rt.windows[windowId] ?? (rt.windows[windowId] = { synced: false, fails: 0, failedAt: 0 });

  let { tabs, groups } = await snapshot(windowId);
  if (!tabs.length) return;
  pruneRuntime(model, rt, windowId, tabs, groups);

  try {
    const surplus = adopt(model, rt, windowId, tabs, groups);
    if (surplus.length) await chrome.tabs.remove(surplus).catch(() => {});
    // Session restore leaves background tabs unloaded, which for a dormant pin
    // means no name and no icon. They're tiny, so load them.
    for (const tab of tabs) {
      if (tab.status === 'unloaded' && rt.instances[tab.id] && placeholderPinId(tab)) {
        chrome.tabs.reload(tab.id).catch(() => {});
      }
    }

    const present = instancesIn(rt, windowId);
    const pinnedCount = tabs.filter((t) => t.pinned).length;
    const ordered = model.folders.flatMap((f) => pinsIn(model, f.id));
    for (const [position, pin] of ordered.entries()) {
      if (present.has(pin.id)) continue;
      const tab = await chrome.tabs.create({
        windowId,
        url: placeholderUrl(pin.id),
        index: pinnedCount + position,
        active: false,
      });
      rt.instances[tab.id] = { pinId: pin.id, windowId, placed: false };
      present.set(pin.id, tab.id);
    }

    ({ tabs, groups } = await snapshot(windowId));
    if (!layoutOk(model, rt, windowId, tabs, groups)) {
      state.synced = false;
      await arrange(model, rt, windowId);
      ({ tabs, groups } = await snapshot(windowId));
      pruneRuntime(model, rt, windowId, tabs, groups);
      if (!layoutOk(model, rt, windowId, tabs, groups)) throw new Error(`window ${windowId} did not settle`);
    }

    for (const inst of Object.values(rt.instances)) if (inst.windowId === windowId) inst.placed = true;
    state.synced = true;
    state.fails = 0;
  } catch (error) {
    state.synced = false;
    if (!isDragError(error)) {
      state.fails += 1;
      state.failedAt = Date.now();
    }
    throw error;
  } finally {
    await saveRuntime();
  }
}

export async function reconcileAll() {
  const rt = await getRuntime();
  const windowIds = await normalWindowIds();
  const open = new Set(windowIds);
  for (const key of Object.keys(rt.windows)) if (!open.has(Number(key))) delete rt.windows[key];
  for (const [key, inst] of Object.entries(rt.instances)) if (!open.has(inst.windowId)) delete rt.instances[key];
  for (const [key, entry] of Object.entries(rt.groups)) if (!open.has(entry.windowId)) delete rt.groups[key];

  for (const windowId of windowIds) {
    try {
      await reconcileWindow(windowId);
    } catch (error) {
      if (isDragError(error)) retryHandler(windowId);
      else console.warn('[super-pins] sync failed', windowId, error);
    }
  }
  await saveRuntime();
}

// Chromium refuses to move tabs while the user is dragging one, and the tab
// strip is in flux until they let go. A move to the tab's own position changes
// nothing and tells us which state we're in.
async function isDragging(windowId) {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (!tab) return false;
  try {
    await chrome.tabs.move(tab.id, { index: tab.index });
    return false;
  } catch (error) {
    return isDragError(error);
  }
}

// Something happened in `windowId`: work out what, then bring every window in line.
// `force` is for explicit requests from the popup; events give up on a window
// that keeps failing so a tab strip we can't fix doesn't turn into a loop.
export async function settle(windowId, { force = false } = {}) {
  const rt = await getRuntime();
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win || win.type !== 'normal' || win.incognito) return;

  const state = rt.windows[windowId];
  if (!force && state?.fails >= MAX_FAILS && Date.now() - state.failedAt < FAIL_COOLDOWN_MS) return;
  if (await isDragging(windowId)) throw new Error('user may be dragging a tab');

  const changed = state?.synced ? await interpret(windowId) : false;
  if (changed) {
    await reconcileAll();
    applyPageScriptEverywhere();
    flushFavicons();
  } else {
    await reconcileWindow(windowId);
  }
}
