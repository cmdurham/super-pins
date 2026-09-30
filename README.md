# Super Pins

Arc's **pinned tabs** for [Helium](https://helium.computer) (and any Chromium browser).
Helium's own pins behave like Arc's favorites; super pins are the other kind: named,
foldered, in every window, and still there after a restart.

## Install

1. Open `helium://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Optional: pin the Super Pins button to the toolbar.

## Use

| Action | How |
| --- | --- |
| Super pin the current tab | `⌥⇧D`, the toolbar button, or right-click the page → **Super pin this tab** |
| Pin into a particular folder | Toolbar button → hover the folder → 📌, or drag the tab into that group |
| Unpin | `⌥⇧D` again, the ✕ in the list, or drag the tab out of its group |
| Rename a pin | Toolbar button → ✎, or right-click the page → **Rename super pin…** |
| New folder | Toolbar button → **New folder** |
| Rename or recolour a folder | Edit the tab group as usual, or use the list |
| Reorder pins and folders | Drag the tabs or groups in the tab bar, or drag rows in the list |
| Go back to the pinned page | `⌥⇧H`, or **Back to pinned page** |
| Pin the page you wandered to instead | **Pin this page instead** |
| Put a closed pin to sleep | `⌘W`. The tab comes straight back, unloaded |
| Undo an unpin | Toolbar button → **Recently unpinned** → ↺ |
| Pin an address without opening it | Toolbar button → hover the folder → 🔗 |

Every window gets the same pins in the same order, at the front of the tab bar, right
after Helium's native pinned tabs. A change in one window shows up in the others.

To use Arc's `⌘D`, rebind it at `helium://extensions/shortcuts`. **Rename** and
**Pin this page instead** can be given shortcuts there too.

## How it maps to Arc

| Arc | Super Pins |
| --- | --- |
| Pinned tabs survive restarts | Pins are saved in the extension's storage and rebuilt in every window at launch |
| Same pins in every window | One tab per pin per window, kept in the same order |
| Folders | Tab groups, one per folder. Name, colour, order and collapsed state are saved |
| Rename a tab | The name replaces the page's title in the tab bar and sticks as you browse |
| Pins stay unloaded until clicked | A pin is a tiny placeholder page with the pin's name and icon until you select it |
| `⌘W` closes the page but keeps the pin | The tab is replaced by a fresh unloaded one in the same spot |
| A pin remembers its URL | Browse away, then **Back to pinned page** returns; **Pin this page instead** re-homes it |
| Links to other sites leave the pin alone | They open in a new tab just after the pins (can be turned off) |
| Drag to pin and unpin | Drag a tab into or out of a super-pin group (each can be turned off) |

## How it works and its limits

An extension can't draw in the tab bar, so everything is built from real tabs and tab
groups, and the extension keeps them matching the saved list.

- **Folders are one level deep.** Chromium's tab groups can't nest, and every pin has
  to be in a folder; the first one is called *Pins*. An empty folder has no group in
  the tab bar, because a group can't be empty. It's still in the list.
- **Each window has its own copy of a pin.** Arc shows one shared tab; here the same
  pin can be loaded in two windows at once, on different pages.
- **Renaming** works by setting the page's title from a script. It can't reach
  `helium://` pages, the extension store, or the PDF viewer. Those pins show their
  own title while loaded, and your name while unloaded.
- **Ungroup** on a folder with two or more pins is undone: the group is put back. To
  remove a folder, delete it from the list. With one pin in the folder, *Ungroup*
  looks the same as dragging that pin out, so it unpins it.
- **Dragging a pin to another window** leaves an ordinary tab there; the window it
  came from gets an unloaded copy back.
- **Pinning a super pin natively** (right-click → *Pin*) turns it into a Helium pin
  and removes the super pin.
- **Tabs opened from a pin** (`⌘`-click, *Duplicate*, *New tab to the right*) start
  inside the pin's group, because that's what Chromium does. They're moved out to
  just after the pins a moment later.
- **Private windows** don't get pins.
- If the extension is turned off or removed, unloaded pins close, since they're
  extension pages. The saved list is kept while the extension stays installed.
  **Export** in the full manager makes a backup you can **Import** later.
- There's no sync between computers, because Helium has no account to sync through.
  Export and Import are the way to move pins.

Debugging: open the service worker's console from `helium://extensions` and use
`superPins.getModel()`, `superPins.getRuntime()`, `superPins.scheduleAll()`.

## Files

| File | What it does |
| --- | --- |
| `background.js` | Browser events, shortcuts, menus, and the messages the manager sends |
| `engine.js` | Keeps tab bars and the saved pins in step, in both directions |
| `store.js` | The saved pins, the per-session tab bookkeeping, and the work queue |
| `page-script.js` | Runs inside a pin's page: holds the name, catches links to other sites |
| `pin.html`, `pin.js` | The unloaded placeholder tab |
| `popup.html`, `options.html`, `popup.js` | The manager, as a toolbar popup and as a full page |
