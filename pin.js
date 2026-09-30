// A dormant super pin. It costs next to nothing while it sits in the tab strip
// wearing the pin's name and icon, and turns into the real page the first time
// the tab is selected.

const OPEN_DELAY_MS = 120; // ride out the tab being selected only in passing

const pinId = location.hash.slice(1);
const $ = (id) => document.getElementById(id);

let pin = null;
let timer = null;
let leaving = false;

const faviconApiUrl = (pageUrl) =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=32`);

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

function render() {
  if (!pin) {
    document.title = 'Super Pin';
    $('name').textContent = 'This super pin was removed';
    $('url').textContent = '';
    $('status').textContent = 'You can close this tab.';
    $('favicon').hidden = true;
    $('open').hidden = true;
    return;
  }
  const name = pin.title || pin.pageTitle || hostOf(pin.url);
  const icon = pin.favicon || faviconApiUrl(pin.url);
  document.title = name;
  $('icon').href = icon;
  $('favicon').src = icon;
  $('favicon').hidden = false;
  $('name').textContent = name;
  $('url').textContent = pin.url;
  $('open').hidden = false;
}

async function load() {
  const { model } = await chrome.storage.local.get('model');
  pin = model?.pins?.find((p) => p.id === pinId) ?? null;
  render();
  wake();
}

async function open() {
  if (!pin || leaving) return;
  leaving = true;
  $('status').textContent = 'Opening…';
  try {
    if (/^https?:/i.test(pin.url)) {
      // replace() keeps this page out of the tab's history, so Back never lands here.
      location.replace(pin.url);
    } else {
      const tab = await chrome.tabs.getCurrent();
      await chrome.tabs.update(tab.id, { url: pin.url });
    }
  } catch (error) {
    leaving = false;
    $('status').textContent = `Couldn't open this page: ${error.message}`;
  }
}

// Open once this tab is the selected one. Checked after a short delay, so a
// selection that only passes through doesn't load the page.
function wake() {
  clearTimeout(timer);
  if (!pin || leaving) return;
  timer = setTimeout(async () => {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.active) open();
  }, OPEN_DELAY_MS);
}

document.addEventListener('visibilitychange', wake);
$('open').addEventListener('click', open);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'wake') wake();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.model && !leaving) load();
});

load();
