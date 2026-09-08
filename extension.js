import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const Display = global.get_display();
const WindowManager = global.get_window_manager();
const WorkspaceManager = global.get_workspace_manager();

import {
  initLogging,
  stopLogging,
  createLogger,
  flushBuffer,
} from './logger.js';

const journal = createLogger(import.meta.url);

// ===== dim combos (low -> high intensity) =====
const DIM_COMBOS = [
  { opacity: 255, brightness: 0.0, desaturation: 0.0, iconFile: 'icon1-symbolic.svg', cssClass: 'lamp-level-1' },
  { opacity: 255, brightness: -0.2, desaturation: 0.0, iconFile: 'icon2-symbolic.svg', cssClass: 'lamp-level-2' },
  { opacity: 204, brightness: -0.1, desaturation: 1.0, iconFile: 'icon3-symbolic.svg', cssClass: 'lamp-level-3' },
];

// ===== state =====
let state;

function initState() {
  state = {
    connections: [],
    dimmed: new Set(),
    brightnessEffectByActor: new WeakMap(),
    desatEffectByActor: new WeakMap(),
    lastSoloWindow: null,
    comboIndex: 0,
    combo: DIM_COMBOS[0],

    // flush buffer
    pending: null,
    flushId: 0,
  };
}

function setDimCombo(index) {
  if (!state) return;
  state.comboIndex = index;
  state.combo = DIM_COMBOS[index];
  journal(`Dim combo -> ${index} (${JSON.stringify(state.combo)})`);

  for (const actor of state.dimmed)
    applyDimEffects(actor);
}

// ===== flush buffer =====

function scheduleFlush(work) {
  if (!state) return;

  const p = (state.pending ??= {});
  if (work.reevaluate) p.reevaluate = true;
  if (work.restoreMinimized) p.restoreMinimized = true;
  if (work.justMinimizedWindow) p.justMinimizedWindow = work.justMinimizedWindow;
  if (work.refresh) p.refresh = true;

  if (state.flushId)
    return;

  state.flushId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    if (state) {
      state.flushId = 0;
      flushPending();
    }
    return GLib.SOURCE_REMOVE;
  });
}

function flushPending() {
  if (!state || !state.pending)
    return;

  const { reevaluate, restoreMinimized, justMinimizedWindow, refresh } = state.pending;
  state.pending = null;

  if (reevaluate)
    ensureFocusedWindow(!!restoreMinimized, justMinimizedWindow ?? null);
  else if (refresh)
    refreshState();
}

function cancelFlush() {
  if (!state) return;
  if (state.flushId) {
    GLib.Source.remove(state.flushId);
    state.flushId = 0;
  }
  state.pending = null;
}

// ===== queries =====

function windowExistsOnCurrentWorkspace(win) {
  if (!win) return false;
  const type = win.get_window_type();
  if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG)
    return false;
  if (win.is_skip_taskbar()) return false;
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
    if (rectsIntersect(target, top)) return true;
  }
  return false;
}

// ===== Dimming functions (no animation) =====

function applyDimEffects(actor) {
  const { opacity, brightness, desaturation } = state.combo;

  actor.opacity = opacity;

  let brightnessEffect = state.brightnessEffectByActor.get(actor);
  if (brightness !== 0.0) {
    if (!brightnessEffect) {
      brightnessEffect = new Clutter.BrightnessContrastEffect();
      actor.add_effect(brightnessEffect);
      state.brightnessEffectByActor.set(actor, brightnessEffect);
    }
    brightnessEffect.set_brightness(brightness);
  } else if (brightnessEffect) {
    actor.remove_effect(brightnessEffect);
    state.brightnessEffectByActor.delete(actor);
  }

  let desatEffect = state.desatEffectByActor.get(actor);
  if (desaturation > 0.0) {
    if (!desatEffect) {
      desatEffect = new Clutter.DesaturateEffect({ factor: desaturation });
      actor.add_effect(desatEffect);
      state.desatEffectByActor.set(actor, desatEffect);
    } else {
      desatEffect.factor = desaturation;
    }
  } else if (desatEffect) {
    actor.remove_effect(desatEffect);
    state.desatEffectByActor.delete(actor);
  }

  state.dimmed.add(actor);
}

function removeDimEffects(actor) {
  actor.opacity = 255;

  const brightnessEffect = state.brightnessEffectByActor.get(actor);
  if (brightnessEffect) {
    actor.remove_effect(brightnessEffect);
    state.brightnessEffectByActor.delete(actor);
  }
  const desatEffect = state.desatEffectByActor.get(actor);
  if (desatEffect) {
    actor.remove_effect(desatEffect);
    state.desatEffectByActor.delete(actor);
  }
  state.dimmed.delete(actor);
}

function undimAll() {
  for (const actor of state.dimmed) {
    removeDimEffects(actor);
  }
  state.dimmed.clear();
}

// ===== unified refresh (diff-based: only touches actors that need to change) =====

function refreshState() {
  const focusWin = Display.get_focus_window();
  const eligible = windowsOnCurrentWorkspace().filter(isEligible);

  if (!focusWin || !eligible.includes(focusWin)) {
    undimAll();
    focusedBorder.remove();
    return;
  }

  const focusedActor = focusWin.get_compositor_private();
  if (focusedActor) removeDimEffects(focusedActor);

  const others = eligible.filter(w => w !== focusWin);
  const othersActors = new Set();
  for (const other of others) {
    const actor = other.get_compositor_private();
    if (!actor) continue;
    othersActors.add(actor);
    applyDimEffects(actor); // cheap if already dimmed: reuses cached effect objects
  }

  // Sweep out anything still marked dimmed that shouldn't be
  // (moved workspace, minimized, or left over from a prior state).
  for (const actor of [...state.dimmed]) {
    if (actor !== focusedActor && !othersActors.has(actor))
      removeDimEffects(actor);
  }

  focusedBorder.update(focusWin); // internal diff: only rebuilds if the tracked window changed
}

// ===== border =====

const FOCUSED_BORDER_CLASS = 'focused-border';

const focusedBorder = makeBorderTracker(FOCUSED_BORDER_CLASS);

function makeBorderTracker(cssClass) {
  let border = null;
  let trackedActor = null;
  let signals = [];

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
      const onGeometryChanged = () => scheduleFlush({ refresh: true });
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
    remove();
  }

  return { update, remove, restack, removeIfActorMatches, destroy };
}

function borderRestack() {
  focusedBorder.restack();
}

function borderRemoveIfMatches(actor) {
  focusedBorder.removeIfActorMatches(actor);
}

function borderDestroy() {
  focusedBorder.destroy();
}

// ===== focus policy =====

function ensureFocusedWindow(restoreMinimized = false, justMinimizedWindow = null) {
  const allWindows = windowsOnCurrentWorkspace();
  if (allWindows.length === 0) {
    state.lastSoloWindow = null;
    refreshState();
    return;
  }
  const visible = allWindows.filter(w => !w.minimized);

  if (allWindows.length === 1) {
    const win = allWindows[0];
    const isNewSoloState = state.lastSoloWindow !== win;
    state.lastSoloWindow = win;
    if (win.minimized && !restoreMinimized) {
      refreshState();
      return;
    }
    const wasMinimized = win.minimized;
    if (wasMinimized)
      win.unminimize();
    const wasMaximized = win.get_maximized() === Meta.MaximizeFlags.BOTH;
    const shouldForceMaximize = isNewSoloState || restoreMinimized;
    if (!wasMaximized && shouldForceMaximize)
      win.maximize(3);
    win.get_workspace().activate_with_focus(win, global.get_current_time());
    refreshState();
    return;
  }

  state.lastSoloWindow = null;

  if (visible.length === 0 && allWindows.length === 2) {
    if (!justMinimizedWindow && !restoreMinimized) {
      refreshState();
      return;
    }
    const other = justMinimizedWindow
      ? allWindows.find(w => w !== justMinimizedWindow)
      : allWindows.reduce((a, b) => a.get_user_time() > b.get_user_time() ? a : b);
    if (!other) return;
    other.unminimize();
    other.maximize(3);
    other.get_workspace().activate_with_focus(other, global.get_current_time());
    refreshState();
    return;
  }

  if (visible.length === 0) {
    refreshState();
    return;
  }
  const uncovered = visible.filter(w => !isCoveredFullyOrPartially(w));
  if (uncovered.length === 0) {
    refreshState();
    return;
  }
  let target;
  if (uncovered.length === 1) {
    target = uncovered[0];
  } else {
    target = uncovered.reduce((a, b) =>
      a.get_user_time() > b.get_user_time() ? a : b
    );
  }
  target.get_workspace().activate_with_focus(target, global.get_current_time());
  refreshState();
}

// ===== panel indicator =====

const BIN_SIZE = 64;

class DimLevelIndicator extends PanelMenu.Button {
  static {
    GObject.registerClass(this);
  }

  constructor(extensionPath) {
    super(0.0, 'DimLevelIndicator');

    this._extensionPath = extensionPath;

    this._icon = new St.Icon({
      icon_size: 64,
      style_class: 'system-status-icon',
    });

    this._iconBin = new St.Bin({
      child: this._icon,
      style_class: 'lamp-icon-bin',
      width: BIN_SIZE,
      height: BIN_SIZE,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.add_child(this._iconBin);

    this._syncIconToCombo(state.comboIndex);

    this.connect('button-press-event', (actor, event) => {
      const button = event.get_button();
      if (button === Clutter.BUTTON_PRIMARY) {
        const nextIndex = (state.comboIndex + 1) % DIM_COMBOS.length;
        setDimCombo(nextIndex);
        this._syncIconToCombo(nextIndex);
      }
      return Clutter.EVENT_STOP;
    });
  }

  _syncIconToCombo(index) {
    const combo = DIM_COMBOS[index];
    const iconPath = GLib.build_filenamev([this._extensionPath, 'icons', combo.iconFile]);
    const file = Gio.File.new_for_path(iconPath);

    if (!file.query_exists(null)) {
      journal(`Icon file not found: ${iconPath}`);
      return;
    }

    this._icon.gicon = new Gio.FileIcon({ file });

    for (const c of DIM_COMBOS)
      this._iconBin.remove_style_class_name(c.cssClass);
    this._iconBin.add_style_class_name(combo.cssClass);
  }
}

// ===== extension =====

export default class FocusedWindowManagerExtension extends Extension {

  enable() {
    initLogging(this.uuid, { output: 'file', level: 'debug', enabled: false });
    journal(`Enabled`);

    initState();

    this._connections = [
      [Display, 'notify::focus-window', this.onFocusWindowChanged.bind(this)],
      [WorkspaceManager, 'active-workspace-changed', this.onWorkspaceChanged.bind(this)],
      [Display, 'window-created', this.onWindowCreated.bind(this)],
      [WindowManager, 'destroy', this.onWindowDestroyed.bind(this)],
      [WindowManager, 'minimize', this.onWindowMinimized.bind(this)],
      [WindowManager, 'unminimize', this.onWindowUnminimized.bind(this)],
      [Display, 'restacked', this.onRestacked.bind(this)],
    ].map(([obj, signal, handler]) => [obj, obj.connect(signal, handler)]);

    this._indicator = new DimLevelIndicator(this.path);
    Main.panel.addToStatusArea(`${this.uuid}`, this._indicator);

    refreshState();
  }

  disable() {
    for (const [obj, id] of this._connections)
      obj.disconnect(id);
    this._connections = null;

    this._indicator?.destroy();
    this._indicator = null;

    undimAll();
    borderDestroy();
    cancelFlush();
    state = null;

    flushBuffer();
    stopLogging();
  }

  // ---- signal handlers ----

  onFocusWindowChanged() {
    scheduleFlush({ refresh: true });
  }

  onWorkspaceChanged() {
    scheduleFlush({ reevaluate: true, restoreMinimized: true });
  }

  onWindowCreated() {
    scheduleFlush({ reevaluate: true });
  }

  onWindowDestroyed(wm, actor) {
    borderRemoveIfMatches(actor);
    state.dimmed.delete(actor);
    scheduleFlush({ reevaluate: true });
  }

  onWindowMinimized(wm, actor) {
    borderRemoveIfMatches(actor);
    state.dimmed.delete(actor);
    scheduleFlush({ reevaluate: true, justMinimizedWindow: actor.get_meta_window() });
  }

  onWindowUnminimized() {
    scheduleFlush({ reevaluate: true });
  }

  onRestacked() {
    borderRestack();
    scheduleFlush({ reevaluate: true });
  }
}