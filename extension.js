import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import Cogl from 'gi://Cogl';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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

// ===== shader effect (grayscale) =====
const SHADER_DECL = `
vec3 desaturate(vec3 col) {
    col = pow(col, vec3(2.2));
    float luminance = dot(col, vec3(0.212656, 0.715158, 0.072186));
    vec3 gray = vec3(luminance);
    return pow(gray, vec3(1.0/2.2));
}`;

const SHADER_CODE = `
cogl_color_out.rgb = desaturate(cogl_color_out.rgb);
`;

const GrayscaleShaderEffect = GObject.registerClass(
  class GrayscaleShaderEffect extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
      const hook = Cogl.SnippetHook ? Cogl.SnippetHook.FRAGMENT : Shell.SnippetHook.FRAGMENT;
      this.add_glsl_snippet(hook, SHADER_DECL, SHADER_CODE, false);
    }
  });

// ===== effect types =====
const EffectType = {
  NONE: 'none',
  DESATURATE: 'desaturate',
  BLUR: 'blur',
  BRIGHTNESS_CONTRAST: 'brightness_contrast',
  COLORIZE: 'colorize',
  SHADER: 'shader',
};

const EFFECT_TYPE_VALUES = new Set(Object.values(EffectType));

const EFFECT_LABELS = [
  [EffectType.NONE, 'None'],
  [EffectType.DESATURATE, 'Clutter.DesaturateEffect'],
  [EffectType.BLUR, 'Clutter.BlurEffect'],
  [EffectType.BRIGHTNESS_CONTRAST, 'Clutter.BrightnessContrastEffect'],
  [EffectType.COLORIZE, 'Clutter.ColorizeEffect'],
  [EffectType.SHADER, 'Clutter.ShaderEffect'],
];

const BLUR_STACK_COUNT = 3;
const DEFAULT_OPACITY = 255;
const DEFAULT_ICON = 'applications-graphics-symbolic';

function createEffects(type) {
  switch (type) {
    case EffectType.DESATURATE:
      return [new Clutter.DesaturateEffect({ factor: 0.85 })];

    case EffectType.BLUR:
      return Array.from({ length: BLUR_STACK_COUNT },
        () => new Clutter.BlurEffect());

    case EffectType.BRIGHTNESS_CONTRAST: {
      const effect = new Clutter.BrightnessContrastEffect();
      effect.set_brightness_full(-0.12, -0.10, -0.06);
      effect.set_contrast_full(-0.06, -0.06, -0.04);
      return [effect];
    }

    case EffectType.COLORIZE: {
      const effect = new Clutter.ColorizeEffect();
      effect.set_tint(new Cogl.Color({
        red: 0x78, green: 0x84, blue: 0x96, alpha: 0x80,
      }));
      return [effect];
    }

    case EffectType.SHADER:
      return [new GrayscaleShaderEffect()];

    case EffectType.NONE:
    default:
      return [];
  }
}

function buildEffectsFromSpecs(specs) {
  const effects = [];
  for (const spec of specs) {
    switch (spec.type) {
      case EffectType.BRIGHTNESS_CONTRAST: {
        const b = spec.brightness ?? [0, 0, 0];
        const c = spec.contrast ?? [0, 0, 0];
        if (b.every(v => v === 0) && c.every(v => v === 0)) break;
        const e = new Clutter.BrightnessContrastEffect();
        e.set_brightness_full(b[0], b[1], b[2]);
        e.set_contrast_full(c[0], c[1], c[2]);
        effects.push(e);
        break;
      }

      case EffectType.DESATURATE: {
        const f = spec.factor ?? 1.0;
        if (f === 0.0) break;
        effects.push(new Clutter.DesaturateEffect({ factor: f }));
        break;
      }

      case EffectType.BLUR: {
        const n = spec.count ?? BLUR_STACK_COUNT;
        for (let i = 0; i < n; i++)
          effects.push(new Clutter.BlurEffect());
        break;
      }

      case EffectType.COLORIZE: {
        const t = spec.tint ?? [0x78, 0x84, 0x96, 0x80];
        const e = new Clutter.ColorizeEffect();
        e.set_tint(new Cogl.Color({
          red: t[0], green: t[1], blue: t[2], alpha: t[3],
        }));
        effects.push(e);
        break;
      }

      case EffectType.SHADER:
        effects.push(new GrayscaleShaderEffect());
        break;
    }
  }
  return effects;
}

// ===== lamp presets (cycled by left click) =====
// Lamp 0 is the "None" state — same id as the menu's None entry, no effects,
// no icon file, no CSS class. The panel falls back to the default icon.
// Lamps 1–3 have their own icons and CSS classes.
const LAMP_PRESETS = [
  {
    id: EffectType.NONE,
    label: 'None',
    opacity: DEFAULT_OPACITY,
    iconFile: 'icon1-symbolic.svg', cssClass: 'lamp-level-1',
    effects: [],
  },
  {
    id: 'lamp-2', label: 'Lamp · Level 2',
    opacity: 255,
    iconFile: 'icon2-symbolic.svg', cssClass: 'lamp-level-2',
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.2, -0.2, -0.2], contrast: [0, 0, 0]
      },
    ],
  },
  {
    id: 'lamp-3', label: 'Lamp · Level 3',
    opacity: 204,
    iconFile: 'icon3-symbolic.svg', cssClass: 'lamp-level-3',
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.1, -0.1, -0.1], contrast: [0, 0, 0]
      },
      { type: EffectType.DESATURATE, factor: 1.0 },
    ],
  },
  {
    id: 'lamp-4', label: 'Lamp · Level 4',
    opacity: 170,
    iconFile: 'icon4-symbolic.svg', cssClass: 'lamp-level-4',
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.3, -0.3, -0.3], contrast: [0, 0, 0]
      },
      { type: EffectType.DESATURATE, factor: 1.0 },
    ],
  },
];

// ===== menu presets =====
const MENU_PRESETS = [
  { id: 'fade-70', label: 'Fade · 70%', opacity: 180, types: [] },
  { id: 'fade-50', label: 'Fade · 50%', opacity: 128, types: [] },
  { id: 'slate', label: 'Slate Tint', opacity: 220, types: [EffectType.COLORIZE] },
  { id: 'soft-blur', label: 'Soft Blur', opacity: 200, types: [EffectType.BLUR] },
  { id: 'dim', label: 'Dim', opacity: 230, types: [EffectType.BRIGHTNESS_CONTRAST] },
  { id: 'focus', label: 'Focus', opacity: 200, types: [EffectType.BRIGHTNESS_CONTRAST, EffectType.DESATURATE] },
  { id: 'recede', label: 'Recede', opacity: 170, types: [EffectType.BRIGHTNESS_CONTRAST, EffectType.DESATURATE] },
  { id: 'midnight', label: 'Midnight', opacity: 200, types: [EffectType.BRIGHTNESS_CONTRAST, EffectType.COLORIZE] },
  { id: 'ghost', label: 'Ghost', opacity: 140, types: [EffectType.BRIGHTNESS_CONTRAST, EffectType.DESATURATE, EffectType.BLUR] },
  { id: 'dream', label: 'Dream', opacity: 220, types: [EffectType.BLUR, EffectType.COLORIZE] },
];

const ALL_PRESETS = [...LAMP_PRESETS, ...MENU_PRESETS];

function resolveSelection(id) {
  if (id === EffectType.NONE)
    return { effects: [], opacity: DEFAULT_OPACITY, isNone: true };

  if (EFFECT_TYPE_VALUES.has(id))
    return { effects: createEffects(id), opacity: DEFAULT_OPACITY, isNone: false };

  const preset = ALL_PRESETS.find(p => p.id === id);
  if (!preset)
    return { effects: [], opacity: DEFAULT_OPACITY, isNone: true };

  const effects = preset.effects
    ? buildEffectsFromSpecs(preset.effects)
    : (preset.types ?? []).flatMap(t => createEffects(t));

  return {
    effects,
    opacity: preset.opacity ?? DEFAULT_OPACITY,
    isNone: false,
  };
}

function findLampIndex(id) {
  return LAMP_PRESETS.findIndex(p => p.id === id);
}

// ===== state =====
let state;

function initState() {
  const initialId = LAMP_PRESETS[0].id; // EffectType.NONE
  state = {
    connections: [],
    dimmed: new Set(),
    effectsByActor: new WeakMap(),
    appliedVersionByActor: new WeakMap(),
    lastSoloWindow: null,

    selectionId: initialId,
    plan: resolveSelection(initialId),
    planVersion: 0,
    lampIndex: 0,

    pending: null,
    flushId: 0,
  };
}

function setSelection(id) {
  if (!state) return;
  state.selectionId = id;
  state.plan = resolveSelection(id);
  state.planVersion++;
  journal(`Selection -> ${id}`);
  refreshState();
}

// ===== flush buffer =====
function scheduleFlush(work) {
  if (!state) return;
  const p = (state.pending ??= {});
  if (work.reevaluate) p.reevaluate = true;
  if (work.restoreMinimized) p.restoreMinimized = true;
  if (work.justMinimizedWindow) p.justMinimizedWindow = work.justMinimizedWindow;
  if (work.refresh) p.refresh = true;

  if (state.flushId) return;

  state.flushId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    if (state) {
      state.flushId = 0;
      flushPending();
    }
    return GLib.SOURCE_REMOVE;
  });
}

function flushPending() {
  if (!state || !state.pending) return;
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

// ===== window queries =====
function windowExistsOnCurrentWorkspace(win) {
  if (!win) return false;
  const type = win.get_window_type();
  if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG) return false;
  if (win.is_skip_taskbar()) return false;
  const currentWorkspace = WorkspaceManager.get_active_workspace();
  const winWorkspace = win.get_workspace();
  if (!winWorkspace) return false;
  if (!win.is_on_all_workspaces() && winWorkspace !== currentWorkspace) return false;
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

// ===== effect application (version-tracked diff) =====

function applyDimEffects(actor) {
  if (!state) return;
  const plan = state.plan;

  if (state.appliedVersionByActor.get(actor) === state.planVersion) {
    state.dimmed.add(actor);
    return;
  }

  const oldEffects = state.effectsByActor.get(actor);
  if (oldEffects)
    for (const e of oldEffects) actor.remove_effect(e);

  actor.opacity = plan.opacity;

  const newEffects = plan.effects;
  newEffects.forEach((e, i) => actor.add_effect_with_name(`dim-effect-${i}`, e));

  state.effectsByActor.set(actor, newEffects);
  state.appliedVersionByActor.set(actor, state.planVersion);
  state.dimmed.add(actor);
}

function removeDimEffects(actor) {
  actor.opacity = DEFAULT_OPACITY;

  const effects = state.effectsByActor.get(actor);
  if (effects)
    for (const e of effects) actor.remove_effect(e);

  state.effectsByActor.delete(actor);
  state.appliedVersionByActor.delete(actor);
  state.dimmed.delete(actor);
}

function undimAll() {
  for (const actor of [...state.dimmed])
    removeDimEffects(actor);
  state.dimmed.clear();
}

// ===== unified refresh =====
function refreshState() {
  if (!state) return;

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
    applyDimEffects(actor);
  }

  for (const actor of [...state.dimmed]) {
    if (actor !== focusedActor && !othersActors.has(actor))
      removeDimEffects(actor);
  }

  focusedBorder.update(focusWin);
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
      for (const id of signals) if (id) win.disconnect(id);
    }
    signals = [];
  }

  function remove() {
    disconnectSignals();
    if (border?.get_parent())
      border.get_parent().remove_child(border);
    if (border) { border.destroy(); border = null; }
    trackedActor = null;
  }

  function restack() {
    if (!border || !trackedActor || !border.get_parent()) return;
    global.get_window_group().set_child_above_sibling(border, trackedActor);
  }

  function update(win) {
    if (!win) { remove(); return; }
    const actor = win.get_compositor_private();
    if (!actor || !actor.get_parent()) { remove(); return; }
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
    if (actor === trackedActor) remove();
  }

  function destroy() { remove(); }

  return { update, remove, restack, removeIfActorMatches, destroy };
}

function borderRestack() { focusedBorder.restack(); }
function borderRemoveIfMatches(actor) { focusedBorder.removeIfActorMatches(actor); }
function borderDestroy() { focusedBorder.destroy(); }

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
    if (win.minimized && !restoreMinimized) { refreshState(); return; }
    if (win.minimized) win.unminimize();
    const wasMaximized = win.get_maximized() === Meta.MaximizeFlags.BOTH;
    const shouldForceMaximize = isNewSoloState || restoreMinimized;
    if (!wasMaximized && shouldForceMaximize) win.maximize(3);
    win.get_workspace().activate_with_focus(win, global.get_current_time());
    refreshState();
    return;
  }

  state.lastSoloWindow = null;

  if (visible.length === 0 && allWindows.length === 2) {
    if (!justMinimizedWindow && !restoreMinimized) { refreshState(); return; }
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

  if (visible.length === 0) { refreshState(); return; }
  const uncovered = visible.filter(w => !isCoveredFullyOrPartially(w));
  if (uncovered.length === 0) { refreshState(); return; }

  const target = uncovered.length === 1
    ? uncovered[0]
    : uncovered.reduce((a, b) => a.get_user_time() > b.get_user_time() ? a : b);

  target.get_workspace().activate_with_focus(target, global.get_current_time());
  refreshState();
}

// ===== panel indicator =====
const BIN_SIZE = 64;

class DimLevelIndicator extends PanelMenu.Button {
  static { GObject.registerClass(this); }

  constructor(extensionPath, onSelect) {
    super(0.0, 'DimLevelIndicator');

    this._extensionPath = extensionPath;
    this._onSelect = onSelect;

    this._icon = new St.Icon({
      icon_size: BIN_SIZE,
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

    this._items = new Map(); // id -> PopupMenuItem

    // Singles.
    for (const [type, label] of EFFECT_LABELS) {
      const item = new PopupMenu.PopupMenuItem(label);
      item.setOrnament(type === EffectType.NONE
        ? PopupMenu.Ornament.CHECK
        : PopupMenu.Ornament.NONE);
      item.connect('activate', () => this._selectFromMenu(type));
      this.menu.addMenuItem(item);
      this._items.set(type, item);
    }

    // Separator, then the presets. Lamp-only entries are absent.
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    for (const preset of MENU_PRESETS) {
      const item = new PopupMenu.PopupMenuItem(preset.label);
      item.setOrnament(PopupMenu.Ornament.NONE);
      item.connect('activate', () => this._selectFromMenu(preset.id));
      this.menu.addMenuItem(item);
      this._items.set(preset.id, item);
    }

    this._currentId = state.selectionId;
    this._lampIndex = state.lampIndex;
    this._syncIcon();
  }

  vfunc_event(event) {
    if (event.type() === Clutter.EventType.BUTTON_PRESS) {
      const button = event.get_button();

      if (button === Clutter.BUTTON_PRIMARY) {
        if (this.menu.isOpen) this.menu.close();
        else this._cycleLamp();
        return Clutter.EVENT_STOP;
      }

      if (button === Clutter.BUTTON_SECONDARY) {
        this.menu.toggle();
        return Clutter.EVENT_STOP;
      }
    }
    return super.vfunc_event(event);
  }

  _cycleLamp() {
    // Clear whatever checkmark is showing first — the lamp we're leaving
    // may or may not correspond to a menu item.
    this._items.get(this._currentId)?.setOrnament(PopupMenu.Ornament.NONE);

    this._lampIndex = (this._lampIndex + 1) % LAMP_PRESETS.length;
    const preset = LAMP_PRESETS[this._lampIndex];
    this._currentId = preset.id;

    // Lamp 0 shares its id with the menu's None entry, so mark it.
    // Lamps 1–3 have no menu item; the panel icon carries the state.
    if (this._items.has(preset.id))
      this._items.get(preset.id).setOrnament(PopupMenu.Ornament.CHECK);

    this._syncIcon();
    this._onSelect(preset.id);
  }

  _selectFromMenu(id) {
    if (id === this._currentId) return;

    this._items.get(this._currentId)?.setOrnament(PopupMenu.Ornament.NONE);
    this._items.get(id)?.setOrnament(PopupMenu.Ornament.CHECK);
    this._currentId = id;

    // If the menu pick happens to be a lamp (currently only the None state),
    // keep the cycle index in sync so the next left click continues from it.
    const idx = findLampIndex(id);
    if (idx >= 0) this._lampIndex = idx;

    this._syncIcon();
    this._onSelect(id);
  }

  _syncIcon() {
    for (const p of LAMP_PRESETS)
      if (p.cssClass) this._iconBin.remove_style_class_name(p.cssClass);

    const lamp = LAMP_PRESETS.find(p => p.id === this._currentId);

    // Non-lamp selection, or a lamp with no icon file (the None lamp):
    // fall back to the default icon.
    if (!lamp || !lamp.iconFile) {
      this._icon.gicon = null;
      this._icon.icon_name = DEFAULT_ICON;
      return;
    }

    const iconPath = GLib.build_filenamev([this._extensionPath, 'icons', lamp.iconFile]);
    const file = Gio.File.new_for_path(iconPath);

    if (file.query_exists(null)) {
      this._icon.gicon = new Gio.FileIcon({ file });
    } else {
      journal(`Icon file not found: ${iconPath}`);
      this._icon.gicon = null;
      this._icon.icon_name = DEFAULT_ICON;
    }

    if (lamp.cssClass) this._iconBin.add_style_class_name(lamp.cssClass);
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

    this._indicator = new DimLevelIndicator(this.path, (id) => setSelection(id));
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
  onFocusWindowChanged() { scheduleFlush({ refresh: true }); }
  onWorkspaceChanged() { scheduleFlush({ reevaluate: true, restoreMinimized: true }); }
  onWindowCreated() { scheduleFlush({ reevaluate: true }); }

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

  onWindowUnminimized() { scheduleFlush({ reevaluate: true }); }

  onRestacked() {
    borderRestack();
    scheduleFlush({ reevaluate: true });
  }
}