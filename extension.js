import Shell from 'gi://Shell';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// --- Custom shader effect (grayscale) ----------------------------------------
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

// --- Effect building blocks --------------------------------------------------
const EffectType = {
  DESATURATE: 'desaturate',
  BLUR: 'blur',
  BRIGHTNESS_CONTRAST: 'brightness_contrast',
  COLORIZE: 'colorize',
  SHADER: 'shader',
};

// Clutter.BlurEffect exposes no tunable radius/sigma — the only way to make it
// stronger is to stack instances, since Clutter runs effects sequentially.
const BLUR_STACK_COUNT = 3;
const DEFAULT_OPACITY = 255;

// Turn an array of specs into concrete ClutterEffect instances.
//
// Spec forms:
//   { type: EffectType.DESATURATE,          factor: 0.0–1.0 }
//   { type: EffectType.BLUR,                count: N }
//   { type: EffectType.BRIGHTNESS_CONTRAST, brightness: [r,g,b], contrast: [r,g,b] }
//   { type: EffectType.COLORIZE,            tint: [r,g,b,a] }
//   { type: EffectType.SHADER }
function buildEffects(specs) {
  const effects = [];
  for (const spec of specs) {
    switch (spec.type) {
      case EffectType.DESATURATE: {
        effects.push(new Clutter.DesaturateEffect({
          factor: spec.factor ?? 1.0,
        }));
        break;
      }

      case EffectType.BLUR: {
        const n = spec.count ?? BLUR_STACK_COUNT;
        for (let i = 0; i < n; i++)
          effects.push(new Clutter.BlurEffect());
        break;
      }

      case EffectType.BRIGHTNESS_CONTRAST: {
        const e = new Clutter.BrightnessContrastEffect();
        const b = spec.brightness ?? [0, 0, 0];
        const c = spec.contrast ?? [0, 0, 0];
        e.set_brightness_full(b[0], b[1], b[2]);
        e.set_contrast_full(c[0], c[1], c[2]);
        effects.push(e);
        break;
      }

      case EffectType.COLORIZE: {
        const e = new Clutter.ColorizeEffect();
        const t = spec.tint ?? [0x78, 0x84, 0x96, 0x80];
        // Cogl.Color replaces Clutter.Color (removed in GNOME 47).
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

// --- Presets -----------------------------------------------------------------
// Each preset is a full description of what to apply to a non-focused window:
//   id       — unique key (used by the menu)
//   label    — menu text
//   group    — optional; a separator is inserted whenever this changes
//   opacity  — 0–255, applied via actor.opacity
//   effects  — ordered list of specs, passed to buildEffects()
//
// Add a new preset by appending an object here — no other code needs touching.

const PRESETS = [
  // ---- top level -----------------------------------------------------------
  { id: 'none', label: 'None', group: null, opacity: DEFAULT_OPACITY, effects: [] },

  // ---- singles: one idea, applied alone ------------------------------------
  {
    id: 'fade-70', label: 'Fade · 70%', group: 'Singles',
    opacity: 180, effects: [],
  },
  {
    id: 'fade-50', label: 'Fade · 50%', group: 'Singles',
    opacity: 128, effects: [],
  },
  {
    id: 'grayscale', label: 'Grayscale', group: 'Singles',
    opacity: DEFAULT_OPACITY,
    effects: [{ type: EffectType.SHADER }],
  },
  {
    id: 'desat-soft', label: 'Desaturate · Soft', group: 'Singles',
    opacity: DEFAULT_OPACITY,
    effects: [{ type: EffectType.DESATURATE, factor: 0.5 }],
  },
  {
    id: 'desat-full', label: 'Desaturate · Full', group: 'Singles',
    opacity: DEFAULT_OPACITY,
    effects: [{ type: EffectType.DESATURATE, factor: 1.0 }],
  },
  {
    id: 'blur', label: 'Blur', group: 'Singles',
    opacity: DEFAULT_OPACITY,
    effects: [{ type: EffectType.BLUR }],
  },
  {
    id: 'cool-dim', label: 'Cool Dim', group: 'Singles',
    opacity: DEFAULT_OPACITY,
    effects: [{
      type: EffectType.BRIGHTNESS_CONTRAST,
      brightness: [-0.12, -0.10, -0.06],
      contrast: [-0.06, -0.06, -0.04],
    }],
  },
  {
    id: 'slate', label: 'Slate Tint', group: 'Singles',
    opacity: DEFAULT_OPACITY,
    effects: [{
      type: EffectType.COLORIZE,
      tint: [0x78, 0x84, 0x96, 0x80],
    }],
  },

  // ---- combos: a mood assembled from several stacked effects ---------------
  {
    id: 'whisper', label: 'Whisper', group: 'Combos',
    opacity: 240,
    effects: [{
      type: EffectType.BRIGHTNESS_CONTRAST,
      brightness: [-0.05, -0.04, -0.02],
    }],
  },
  {
    id: 'dim', label: 'Dim', group: 'Combos',
    opacity: 220,
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.15, -0.13, -0.08],
        contrast: [-0.05, -0.05, -0.03],
      },
      { type: EffectType.DESATURATE, factor: 0.3 },
    ],
  },
  {
    id: 'focus', label: 'Focus', group: 'Combos',
    opacity: 200,
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.18, -0.15, -0.10],
        contrast: [-0.08, -0.08, -0.05],
      },
      { type: EffectType.DESATURATE, factor: 0.55 },
    ],
  },
  {
    id: 'recede', label: 'Recede', group: 'Combos',
    opacity: 180,
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.22, -0.19, -0.12],
        contrast: [-0.10, -0.10, -0.06],
      },
      { type: EffectType.DESATURATE, factor: 0.75 },
    ],
  },
  {
    id: 'ghost', label: 'Ghost', group: 'Combos',
    opacity: 150,
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.25, -0.22, -0.15],
        contrast: [-0.12, -0.12, -0.08],
      },
      { type: EffectType.DESATURATE, factor: 0.9 },
      { type: EffectType.BLUR, count: 2 },
    ],
  },
  {
    id: 'midnight', label: 'Midnight', group: 'Combos',
    opacity: 200,
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.18, -0.15, -0.05],
        contrast: [-0.05, -0.05, -0.02],
      },
      { type: EffectType.COLORIZE, tint: [0x2a, 0x3a, 0x6a, 0x60] },
    ],
  },
  {
    id: 'dream', label: 'Dream', group: 'Combos',
    opacity: 230,
    effects: [
      { type: EffectType.BLUR, count: 2 },
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [0.03, 0.03, 0.05],
        contrast: [-0.05, -0.05, -0.05],
      },
      { type: EffectType.COLORIZE, tint: [0xc0, 0xa8, 0xd0, 0x30] },
    ],
  },
];

const DEFAULT_PRESET_ID = 'none';

function findPreset(id) {
  return PRESETS.find(p => p.id === id) ?? PRESETS[0];
}

// --- Panel menu --------------------------------------------------------------
const EffectMenuIndicator = GObject.registerClass(
  class EffectMenuIndicator extends PanelMenu.Button {
    _init(onSelect) {
      super._init(0.0, 'Window Effect', false);

      this._icon = new St.Icon({
        icon_name: 'applications-graphics-symbolic',
        style_class: 'system-status-icon',
      });
      this.add_child(this._icon);

      this._onSelect = onSelect;
      this._items = new Map(); // presetId -> PopupMenuItem

      let lastGroup = undefined;
      for (const preset of PRESETS) {
        const group = preset.group ?? null;
        if (lastGroup !== undefined && group !== lastGroup)
          this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        lastGroup = group;

        const item = new PopupMenu.PopupMenuItem(preset.label);
        item.setOrnament(preset.id === DEFAULT_PRESET_ID
          ? PopupMenu.Ornament.CHECK
          : PopupMenu.Ornament.NONE);
        item.connect('activate', () => this._select(preset.id));
        this.menu.addMenuItem(item);
        this._items.set(preset.id, item);
      }

      this._currentId = DEFAULT_PRESET_ID;
    }

    _select(id) {
      if (id === this._currentId) return;

      this._items.get(this._currentId)?.setOrnament(PopupMenu.Ornament.NONE);
      this._items.get(id)?.setOrnament(PopupMenu.Ornament.CHECK);
      this._currentId = id;

      this._onSelect(id);
    }
  });

// --- Extension ---------------------------------------------------------------
export default class WindowEffectExtension extends Extension {
  _currentPresetId = DEFAULT_PRESET_ID;
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

    this._indicator = new EffectMenuIndicator((id) => this._applyPreset(id));
    Main.panel.addToStatusArea('window-effect-menu', this._indicator);
  }

  _isFocusedActor(actor) {
    const win = actor.get_meta_window();
    return win && win === global.display.focus_window;
  }

  _currentPreset() {
    return findPreset(this._currentPresetId);
  }

  _attachEffect(actor) {
    if (this._effects.has(actor)) return;

    const preset = this._currentPreset();

    // Always write opacity. _detachEffect resets it to DEFAULT_OPACITY, so this
    // is safe even when the preset itself uses full opacity.
    actor.opacity = preset.opacity;

    const effects = buildEffects(preset.effects);

    // add_effect_with_name() rather than add_effect(): Clutter's add_effect()
    // silently no-ops for repeated types, which would collapse the blur stack.
    effects.forEach((effect, i) => {
      actor.add_effect_with_name(`window-effect-${i}`, effect);
    });

    this._effects.set(actor, effects);
  }

  _detachEffect(actor) {
    const effects = this._effects.get(actor);
    if (!effects) return;

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
      if (actor !== this._focusedActor)
        this._attachEffect(actor);
    }
  }

  _applyPreset(id) {
    this._detachFromAllWindows();
    this._currentPresetId = id;

    if (id !== DEFAULT_PRESET_ID)
      this._attachToAllWindows();
    else
      this._focusedActor = null;
  }

  _onWindowMapped(actor) {
    if (this._currentPresetId === DEFAULT_PRESET_ID) return;

    if (this._isFocusedActor(actor)) {
      if (this._focusedActor && this._focusedActor !== actor)
        this._attachEffect(this._focusedActor);
      this._focusedActor = actor;
    } else {
      this._attachEffect(actor);
    }
  }

  _onWindowDestroyed(actor) {
    this._effects.delete(actor); // effect is destroyed along with the actor
    if (this._focusedActor === actor)
      this._focusedActor = null;
  }

  _onFocusChanged() {
    if (this._currentPresetId === DEFAULT_PRESET_ID) return;

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

    this._currentPresetId = DEFAULT_PRESET_ID;
    this._focusedActor = null;
  }
}