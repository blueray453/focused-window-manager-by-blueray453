import Shell from 'gi://Shell';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// --- Custom shader effect (grayscale), used by the "Clutter.ShaderEffect" option ---
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

// --- Effect type registry ---
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

// Unchanged — one effect type in, one array of instances out.
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
        red: 0x78, green: 0x84, blue: 0x96, alpha: 0x80
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

// Explicit-spec builder (unchanged) — for presets carrying their own values.
function buildEffectsFromSpecs(specs) {
  const effects = [];
  for (const spec of specs) {
    switch (spec.type) {
      case EffectType.BRIGHTNESS_CONTRAST: {
        const e = new Clutter.BrightnessContrastEffect();
        const b = spec.brightness ?? [0, 0, 0];
        const c = spec.contrast ?? [0, 0, 0];
        e.set_brightness_full(b[0], b[1], b[2]);
        e.set_contrast_full(c[0], c[1], c[2]);
        effects.push(e);
        break;
      }
      case EffectType.DESATURATE:
        effects.push(new Clutter.DesaturateEffect({ factor: spec.factor ?? 1.0 }));
        break;
      case EffectType.BLUR: {
        const n = spec.count ?? BLUR_STACK_COUNT;
        for (let i = 0; i < n; i++) effects.push(new Clutter.BlurEffect());
        break;
      }
      case EffectType.COLORIZE: {
        const e = new Clutter.ColorizeEffect();
        const t = spec.tint ?? [0x78, 0x84, 0x96, 0x80];
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

// --- Lamp presets (cycled by left click, not shown in the menu) -------------
// Each entry pairs a set of effect params with an icon and a CSS class so the
// panel button itself indicates which level is active.
//
// Level 4 is new — the user-provided table only covered 1–3. Values chosen to
// continue the progression into a deeper dim. Adjust freely.
const LAMP_PRESETS = [
  {
    id: 'lamp-1', label: 'Lamp · Level 1',
    opacity: 255,
    iconFile: 'icon1-symbolic.svg', cssClass: 'lamp-level-1',
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [0.5, 0.5, 0.5], contrast: [0, 0, 0]
      },
    ],
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

// --- Menu presets (shown in the right-click menu) ---------------------------
// Lamp presets are deliberately absent — they live only on the left-click cycle.
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

// Combined lookup used by resolveSelection().
const ALL_PRESETS = [...LAMP_PRESETS, ...MENU_PRESETS];

// Turn a selection id into a concrete plan.
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

function lampIndexFor(id) {
  return LAMP_PRESETS.findIndex(p => p.id === id);
}

// --- Panel menu -------------------------------------------------------------
const EffectMenuIndicator = GObject.registerClass(
  class EffectMenuIndicator extends PanelMenu.Button {
    _init(extensionPath, onSelect) {
      super._init(0.0, 'Window Effect', false);

      this._extensionPath = extensionPath;

      this._icon = new St.Icon({
        icon_name: DEFAULT_ICON,
        style_class: 'system-status-icon',
      });
      this.add_child(this._icon);

      this._onSelect = onSelect;
      this._items = new Map(); // id -> PopupMenuItem

      // Singles.
      for (const [type, label] of EFFECT_LABELS) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.setOrnament(type === EffectType.NONE
          ? PopupMenu.Ornament.CHECK
          : PopupMenu.Ornament.NONE);
        item.connect('activate', () => this._select(type));
        this.menu.addMenuItem(item);
        this._items.set(type, item);
      }

      // Divider, then the menu presets (lamp presets intentionally excluded).
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      for (const preset of MENU_PRESETS) {
        const item = new PopupMenu.PopupMenuItem(preset.label);
        item.setOrnament(PopupMenu.Ornament.NONE);
        item.connect('activate', () => this._select(preset.id));
        this.menu.addMenuItem(item);
        this._items.set(preset.id, item);
      }

      this._currentId = EffectType.NONE;
      this._lampIndex = -1; // so the first left click lands on lamp 1
      this._syncIcon();
    }

    // Left click: close the menu if it's open, otherwise advance the lamp cycle.
    // Right click: toggle the menu.
    vfunc_event(event) {
      if (event.type() === Clutter.EventType.BUTTON_PRESS) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_PRIMARY) {
          if (this.menu.isOpen)
            this.menu.close();
          else
            this._cycleLamp();
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
      this._lampIndex = (this._lampIndex + 1) % LAMP_PRESETS.length;
      const preset = LAMP_PRESETS[this._lampIndex];

      // Clear any checkmark — a lamp is active, which isn't in the menu.
      this._items.get(this._currentId)?.setOrnament(PopupMenu.Ornament.NONE);
      this._currentId = preset.id;

      this._syncIcon();
      this._onSelect(preset.id);
    }

    _select(id) {
      if (id === this._currentId) return;

      this._items.get(this._currentId)?.setOrnament(PopupMenu.Ornament.NONE);
      this._items.get(id)?.setOrnament(PopupMenu.Ornament.CHECK);
      this._currentId = id;

      // If the user picked the same lamp that's currently active, keep its
      // index so the next left click continues from there.
      const idx = lampIndexFor(id);
      if (idx >= 0)
        this._lampIndex = idx;

      this._syncIcon();
      this._onSelect(id);
    }

    _syncIcon() {
      const lamp = LAMP_PRESETS.find(p => p.id === this._currentId);

      // Reset the icon container's background class.
      for (const p of LAMP_PRESETS)
        this._icon.remove_style_class_name(p.cssClass);

      if (!lamp) {
        this._icon.gicon = null;
        this._icon.icon_name = DEFAULT_ICON;
        return;
      }

      const iconPath = GLib.build_filenamev([this._extensionPath, 'icons', lamp.iconFile]);
      const file = Gio.File.new_for_path(iconPath);

      if (file.query_exists(null)) {
        this._icon.gicon = new Gio.FileIcon({ file });
      } else {
        // Fall back to the default icon if the file is missing.
        this._icon.gicon = null;
        this._icon.icon_name = DEFAULT_ICON;
      }

      this._icon.add_style_class_name(lamp.cssClass);
    }
  });

// --- Extension --------------------------------------------------------------
export default class WindowEffectExtension extends Extension {
  _currentId = EffectType.NONE;
  _indicator = null;

  _effects = new Map();   // Meta.WindowActor -> ClutterEffect[]
  _focusedActor = null;

  _mapId = 0;
  _destroyId = 0;
  _focusChangedId = 0;

  enable() {
    this._mapId = global.window_manager.connect('map', (wm, actor) => this._onWindowMapped(actor));
    this._destroyId = global.window_manager.connect('destroy', (wm, actor) => this._onWindowDestroyed(actor));
    this._focusChangedId = global.display.connect('notify::focus-window', () => this._onFocusChanged());

    this._indicator = new EffectMenuIndicator(this.path, (id) => this._applySelection(id));
    Main.panel.addToStatusArea('window-effect-menu', this._indicator);
  }

  _isFocusedActor(actor) {
    const win = actor.get_meta_window();
    return win && win === global.display.focus_window;
  }

  _currentSelection() {
    return resolveSelection(this._currentId);
  }

  _attachEffect(actor) {
    if (this._effects.has(actor)) return;

    const sel = this._currentSelection();
    if (sel.isNone) return;

    actor.opacity = sel.opacity;

    sel.effects.forEach((effect, i) => {
      actor.add_effect_with_name(`window-effect-${i}`, effect);
    });

    this._effects.set(actor, sel.effects);
  }

  _detachEffect(actor) {
    if (!this._effects.has(actor)) return;

    const effects = this._effects.get(actor);
    for (const effect of effects)
      actor.remove_effect(effect);

    actor.opacity = DEFAULT_OPACITY;
    this._effects.delete(actor);
  }

  _detachFromAllWindows() {
    for (const actor of Array.from(this._effects.keys()))
      this._detachEffect(actor);
  }

  _attachToAllWindows() {
    const actors = global.get_window_actors();
    this._focusedActor = actors.find(a => this._isFocusedActor(a)) || null;

    for (const actor of actors) {
      if (actor !== this._focusedActor) this._attachEffect(actor);
    }
  }

  _applySelection(id) {
    this._detachFromAllWindows();
    this._currentId = id;

    if (id !== EffectType.NONE) {
      this._attachToAllWindows();
    } else {
      this._focusedActor = null;
    }
  }

  _onWindowMapped(actor) {
    if (this._currentId === EffectType.NONE) return;

    if (this._isFocusedActor(actor)) {
      if (this._focusedActor && this._focusedActor !== actor)
        this._attachEffect(this._focusedActor);
      this._focusedActor = actor;
    } else {
      this._attachEffect(actor);
    }
  }

  _onWindowDestroyed(actor) {
    this._effects.delete(actor);
    if (this._focusedActor === actor) this._focusedActor = null;
  }

  _onFocusChanged() {
    if (this._currentId === EffectType.NONE) return;

    if (this._focusedActor)
      this._attachEffect(this._focusedActor);

    const focusWindow = global.display.focus_window;
    const newFocusedActor = focusWindow
      ? global.get_window_actors().find(a => a.get_meta_window() === focusWindow)
      : null;

    if (newFocusedActor)
      this._detachEffect(newFocusedActor);

    this._focusedActor = newFocusedActor || null;
  }

  disable() {
    this._detachFromAllWindows();

    if (this._mapId) global.window_manager.disconnect(this._mapId);
    if (this._destroyId) global.window_manager.disconnect(this._destroyId);
    if (this._focusChangedId) global.display.disconnect(this._focusChangedId);

    this._mapId = 0;
    this._destroyId = 0;
    this._focusChangedId = 0;

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    this._currentId = EffectType.NONE;
    this._focusedActor = null;
  }
}