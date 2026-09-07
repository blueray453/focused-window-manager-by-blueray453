import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const Display = global.get_display();
const WindowManager = global.get_window_manager();
const WorkspaceManager = global.get_workspace_manager();

const UNFOCUSED_OPACITY = 252; // out of 255 - tune to taste
const FADE_DURATION = 350;

import {
  initLogging,
  stopLogging,
  createLogger,
  flushBuffer,
} from './logger.js';

const journal = createLogger(import.meta.url);

// ===== state: one object, reset by enable(), torn down by disable() =====
// Module-level state survives disable->enable in GNOME, so enable() must
// always start from a fresh initState().
let state;

function initState() {
  state = {
    connections: [],        // [object, signalId]
    dimmed: new Set(),      // actors currently dimmed
    border: null,           // St.Bin or null
    borderActor: null,      // window actor the border currently tracks
    borderSignals: [],      // signal ids on the tracked window
    borderUpdateId: 0,      // idle id: debounced border update
    reevalId: 0,            // idle id: debounced focus reevaluation
    reevalRestoreMinimized: false, // sticky flag, see scheduleReevaluate()
    reevalJustMinimizedWindow: null, // last window minimized within this debounce window
    lastSoloWindow: null, // tracks which window we last saw as the workspace's only window
  };
}

// ===== queries (pure: read the shell, return answers) =====

function windowExistsOnCurrentWorkspace(win) {
  if (!win) return false;

  const type = win.get_window_type();
  if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG)
    return false;

  if (win.is_skip_taskbar())
    return false;

  const currentWorkspace = WorkspaceManager.get_active_workspace();
  const winWorkspace = win.get_workspace();
  if (!winWorkspace) return false;
  if (!win.is_on_all_workspaces() && winWorkspace !== currentWorkspace)
    return false;

  return true;
}

function isEligible(win) {
  return windowExistsOnCurrentWorkspace(win) && !win.minimized;
}

function windowsOnCurrentWorkspace() {
  return Display.list_all_windows().filter(windowExistsOnCurrentWorkspace);
}

function rectClippedToWorkArea(rect, workArea) {
  const x = Math.max(rect.x, workArea.x);
  const y = Math.max(rect.y, workArea.y);
  const right = Math.min(rect.x + rect.width, workArea.x + workArea.width);
  const bottom = Math.min(rect.y + rect.height, workArea.y + workArea.height);
  return { x, y, width: right - x, height: bottom - y };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

function isCoveredFullyOrPartially(window) {
  if (window.minimized) return false;

  const windows = Display.sort_windows_by_stacking(windowsOnCurrentWorkspace());
  const targetIndex = windows.indexOf(window);
  if (targetIndex === -1) return false;

  const workArea = WorkspaceManager.get_active_workspace()
    .get_work_area_for_monitor(window.get_monitor());

  const target = rectClippedToWorkArea(window.get_frame_rect(), workArea);
  if (target.width <= 0 || target.height <= 0) return false;

  for (let i = targetIndex + 1; i < windows.length; i++) {
    const topWin = windows[i];
    if (topWin.minimized) continue;

    const top = rectClippedToWorkArea(topWin.get_frame_rect(), workArea);
    if (top.width <= 0 || top.height <= 0) continue;

    if (rectsIntersect(target, top))
      return true;
  }

  return false;
}

// ===== animations (plain functions over state.dimmed) =====
// Set ANIMATIONS_ENABLED = false to kill all animation without touching
// any focus-tracking logic.

const ANIMATIONS_ENABLED = true;

function dimFocus(win, others) {
  const focusedActor = win?.get_compositor_private();
  if (!focusedActor)
    return;

  if (!ANIMATIONS_ENABLED) {
    undimAll();
    return;
  }

  focusedActor.remove_all_transitions();
  focusedActor.ease({
    opacity: 255,
    duration: FADE_DURATION,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
  });
  state.dimmed.delete(focusedActor);

  for (const otherWin of others) {
    const actor = otherWin.get_compositor_private();
    if (!actor)
      continue;

    actor.remove_all_transitions();
    actor.ease({
      opacity: UNFOCUSED_OPACITY,
      duration: FADE_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
    state.dimmed.add(actor);
  }
}

function undimAll() {
  for (const actor of state.dimmed) {
    actor.remove_all_transitions();
    actor.ease({
      opacity: 255,
      duration: FADE_DURATION,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }
  state.dimmed.clear();
}

// Scale-in reveal, used identically whether a window was just maximized
// or just restored from minimized - both are "this window just became
// the visible one" and should feel the same.
function reveal(win) {
  if (!ANIMATIONS_ENABLED)
    return;

  const actor = win?.get_compositor_private();
  if (!actor)
    return;

  actor.set_pivot_point(0.5, 0.5);
  actor.remove_all_transitions();
  actor.set_scale(0, 0);
  actor.ease({
    scale_x: 1,
    scale_y: 1,
    duration: FADE_DURATION,
    mode: Clutter.AnimationMode.EASE_OUT,
  });
}

// ===== border (plain functions over state.border*) =====

const FOCUSED_BORDER_CLASS = 'focused-border';
const ACTIVATED_BORDER_CLASS = 'activated-border';

const focusedBorder = makeBorderTracker(FOCUSED_BORDER_CLASS);
const activatedBorder = makeBorderTracker(ACTIVATED_BORDER_CLASS);

function makeBorderTracker(cssClass) {
  let border = null;
  let trackedActor = null;
  let signals = [];
  let updateId = 0;

  function disconnectSignals() {
    const win = trackedActor?.get_meta_window();
    if (win) {
      for (const id of signals) {
        if (id) win.disconnect(id);
      }
    }
    signals = [];
  }

  function remove() {
    disconnectSignals();
    if (border?.get_parent())
      border.get_parent().remove_child(border);
    if (border) {
      border.destroy();
      border = null;
    }
    trackedActor = null;
  }

  function restack() {
    if (!border || !trackedActor || !border.get_parent())
      return;
    global.get_window_group().set_child_above_sibling(border, trackedActor);
  }

  function scheduleUpdate(win) {
    if (updateId)
      return;
    updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      updateId = 0;
      update(win);
      return GLib.SOURCE_REMOVE;
    });
  }

  function update(win) {
    if (!win) {
      remove();
      return;
    }

    const actor = win.get_compositor_private();
    if (!actor || !actor.get_parent()) {
      remove();
      return;
    }

    if (trackedActor !== actor) {
      remove();
      border = new St.Bin({ style_class: cssClass, reactive: false });
      trackedActor = actor;

      const onGeometryChanged = () => scheduleUpdate(win);
      signals = [
        win.connect('position-changed', onGeometryChanged),
        win.connect('size-changed', onGeometryChanged),
        win.connect('workspace-changed', onGeometryChanged),
      ];

      actor.get_parent().add_child(border);
      restack();
    }

    const rect = win.get_frame_rect();
    border.set_position(rect.x, rect.y);
    border.set_size(rect.width, rect.height);
    restack();
  }

  function removeIfActorMatches(actor) {
    if (actor === trackedActor)
      remove();
  }

  function destroy() {
    if (updateId) {
      GLib.Source.remove(updateId);
      updateId = 0;
    }
    remove();
  }

  return { update, remove, restack, removeIfActorMatches, destroy };
}

function borderUpdate() {
  const win = Display.get_focus_window();

  if (!isEligible(win)) {
    focusedBorder.remove();
    activatedBorder.remove();
    return;
  }

  focusedBorder.update(win); // win === Display.focus_window, so it's always genuinely focused

  const parent = win.get_transient_for();
  const parentAppearsActivated =
    parent && isEligible(parent) && parent.appears_focused() && !parent.has_focus();

  if (parentAppearsActivated)
    activatedBorder.update(parent);
  else
    activatedBorder.remove();
}

function borderRestack() {
  focusedBorder.restack();
  activatedBorder.restack();
}

function borderRemoveIfMatches(actor) {
  focusedBorder.removeIfActorMatches(actor);
  activatedBorder.removeIfActorMatches(actor);
}

function borderDestroy() {
  focusedBorder.destroy();
  activatedBorder.destroy();
}

// ===== focus policy (plain functions over state.reeval*) =====

function scheduleReevaluate(options = {}) {
  state.reevalRestoreMinimized =
    state.reevalRestoreMinimized || !!options.restoreMinimized;

  if (options.justMinimizedWindow)
    state.reevalJustMinimizedWindow = options.justMinimizedWindow;

  if (state.reevalId)
    return;

  state.reevalId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    state.reevalId = 0;
    const restoreMinimized = state.reevalRestoreMinimized;
    const justMinimizedWindow = state.reevalJustMinimizedWindow;
    state.reevalRestoreMinimized = false;
    state.reevalJustMinimizedWindow = null;
    ensureFocusedWindow(restoreMinimized, justMinimizedWindow);
    return GLib.SOURCE_REMOVE;
  });
}

function ensureFocusedWindow(restoreMinimized = false, justMinimizedWindow = null) {
  const allWindows = windowsOnCurrentWorkspace();

  if (allWindows.length === 0) {
    state.lastSoloWindow = null;
    return;
  }

  const visible = allWindows.filter(w => !w.minimized);

  if (allWindows.length === 1) {
    const win = allWindows[0];

    const isNewSoloState = state.lastSoloWindow !== win;
    state.lastSoloWindow = win;

    if (win.minimized && !restoreMinimized)
      return;

    const wasMinimized = win.minimized;
    if (wasMinimized)
      win.unminimize();

    const wasMaximized = win.get_maximized() === Meta.MaximizeFlags.BOTH;
    const shouldForceMaximize = isNewSoloState || restoreMinimized;

    if (!wasMaximized && shouldForceMaximize)
      win.maximize(3);

    win.get_workspace().activate_with_focus(win, global.get_current_time());
    undimAll();

    if (wasMinimized || (!wasMaximized && shouldForceMaximize))
      reveal(win);

    borderUpdate();
    return;
  }

  // Case 2: multiple windows exist - reset solo tracking so the next
  // 1-window transition is always treated as fresh.
  state.lastSoloWindow = null;

  if (visible.length === 0 && allWindows.length === 2) {
    if (!justMinimizedWindow && !restoreMinimized)
      return; // ambient recheck while both are already minimized - leave them alone

    const other = justMinimizedWindow
      ? allWindows.find(w => w !== justMinimizedWindow)
      : allWindows.reduce((a, b) => a.get_user_time() > b.get_user_time() ? a : b);

    if (!other) return;

    other.unminimize();
    other.maximize(3);
    other.get_workspace().activate_with_focus(other, global.get_current_time());
    undimAll();
    reveal(other);
    borderUpdate();
    return;
  }

  if (visible.length === 0) return;

  const uncovered = visible.filter(w => !isCoveredFullyOrPartially(w));
  if (uncovered.length === 0) return;

  let target;
  if (uncovered.length === 1) {
    target = uncovered[0];
  } else {
    target = uncovered.reduce((a, b) =>
      a.get_user_time() > b.get_user_time() ? a : b
    );
  }

  target.get_workspace().activate_with_focus(target, global.get_current_time());
  borderUpdate();
}

function policyDestroy() {
  if (state.reevalId) {
    GLib.Source.remove(state.reevalId);
    state.reevalId = 0;
  }
}

// ===== extension: wiring + one handler per signal =====

export default class FocusedWindowManagerExtension extends Extension {

  enable() {
    initLogging(this.uuid, { output: 'file', level: 'debug', enabled: false });
    journal(`Enabled`);

    initState();

    // ---- wiring: one line per signal, nothing inline ----
    this._connections = [
      [Display, 'notify::focus-window', this.onFocusWindowChanged.bind(this)],
      [WorkspaceManager, 'active-workspace-changed', this.onWorkspaceChanged.bind(this)],
      [Display, 'window-created', this.onWindowCreated.bind(this)],
      [WindowManager, 'destroy', this.onWindowDestroyed.bind(this)],
      [WindowManager, 'minimize', this.onWindowMinimized.bind(this)],
      [WindowManager, 'unminimize', this.onWindowUnminimized.bind(this)],
      [Display, 'restacked', this.onRestacked.bind(this)],
    ].map(([obj, signal, handler]) => [obj, obj.connect(signal, handler)]);

    borderUpdate();
  }

  disable() {
    for (const [obj, id] of this._connections)
      obj.disconnect(id);
    this._connections = null;

    undimAll();
    borderDestroy();
    policyDestroy();
    state = null;

    flushBuffer();
    stopLogging();
  }

  // ---- one func per signal, in wiring order ----

  onFocusWindowChanged() {
    const win = Display.get_focus_window();

    if (isEligible(win)) {
      const others = windowsOnCurrentWorkspace()
        .filter(w => w !== win && isEligible(w));
      dimFocus(win, others);
    }

    borderUpdate();
  }

  onWorkspaceChanged() {
    // arriving on this workspace should restore a lone minimized window
    scheduleReevaluate({ restoreMinimized: true });
    borderUpdate();
  }

  onWindowCreated() {
    scheduleReevaluate();

    // A newly created window can become focused before the next idle pass.
    // Refresh the border once the compositor actor exists.
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (state)
        borderUpdate();
      return GLib.SOURCE_REMOVE;
    });
  }

  onWindowDestroyed(wm, actor) {
    borderRemoveIfMatches(actor);
    scheduleReevaluate();
    borderUpdate();
  }

  onWindowMinimized(wm, actor) {
    scheduleReevaluate({ justMinimizedWindow: actor.get_meta_window() });
    borderRemoveIfMatches(actor);
  }

  onWindowUnminimized() {
    scheduleReevaluate();
    borderUpdate();
  }

  onRestacked() {
    scheduleReevaluate();
    borderRestack();
  }
}
