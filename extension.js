import Shell from 'gi://Shell';
import Cogl from 'gi://Cogl';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

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

// Clutter.BlurEffect exposes no radius/sigma/brightness — it is a fixed, very
// mild blur. The only way to make it stronger is to stack instances, since
// Clutter runs an actor's effects sequentially through the pipeline.
const BLUR_STACK_COUNT = 3;

const DEFAULT_OPACITY = 255;

// Unchanged from before — one effect type in, one array of instances out,
// using the shared default parameters.
function createEffects(type) {
  switch (type) {
    case EffectType.DESATURATE:
      // 1.0 is full black-and-white, which reads as harsh. 0.85 leaves
      // a whisper of the original colour so the window still looks alive.
      return [new Clutter.DesaturateEffect({ factor: 0.85 })];

    case EffectType.BLUR:
      return Array.from({ length: BLUR_STACK_COUNT },
        () => new Clutter.BlurEffect());

    case EffectType.BRIGHTNESS_CONTRAST: {
      const effect = new Clutter.BrightnessContrastEffect();

      // Dim slightly, pulling red/green down a touch more than blue.
      // That tiny asymmetry is what makes it read as "cool and receding"
      // instead of "muddy". Values are in [-1, 1], 0 = unchanged.
      effect.set_brightness_full(-0.12, -0.10, -0.06);

      // Soften contrast a little so highlights don't pop forward.
      effect.set_contrast_full(-0.06, -0.06, -0.04);

      return [effect];
    }

    case EffectType.COLORIZE: {
      const effect = new Clutter.ColorizeEffect();

      // Cogl.Color replaces Clutter.Color (removed in GNOME 47).
      // Same channel layout: red, green, blue, alpha — all 0–255.
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

// Build effects from explicit spec objects — used by presets that need their
// own parameter values rather than the shared defaults in createEffects().
//
// Spec forms:
//   { type: EffectType.BRIGHTNESS_CONTRAST, brightness: [r,g,b], contrast: [r,g,b] }
//   { type: EffectType.DESATURATE,          factor: 0–1 }
//   { type: EffectType.BLUR,                count: N }
//   { type: EffectType.COLORIZE,            tint: [r,g,b,a] }
//   { type: EffectType.SHADER }
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
        effects.push(new Clutter.DesaturateEffect({
          factor: spec.factor ?? 1.0,
        }));
        break;

      case EffectType.BLUR: {
        const n = spec.count ?? BLUR_STACK_COUNT;
        for (let i = 0; i < n; i++)
          effects.push(new Clutter.BlurEffect());
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

// --- Preconfigured combos ----------------------------------------------------
// Presets come in two flavours:
//
//   types:   [...] — effect types using the shared defaults from createEffects()
//   effects: [...] — explicit spec objects with their own parameter values
//
// Both may be combined with `opacity`. To add a preset, append an entry.
const PRESETS = [
  // Opacity only — no effects.
  { id: 'fade-70', label: 'Fade · 70%', opacity: 180, types: [] },
  { id: 'fade-50', label: 'Fade · 50%', opacity: 128, types: [] },

  // Single effects, softened by a light fade.
  { id: 'slate', label: 'Slate Tint', opacity: 220, types: [EffectType.COLORIZE] },
  { id: 'soft-blur', label: 'Soft Blur', opacity: 200, types: [EffectType.BLUR] },

  // Escalating dim stacks. Each step drops opacity a little further and adds
  // another effect layer, so the progression reads as "increasingly distant".
  { id: 'dim', label: 'Dim', opacity: 230, types: [EffectType.BRIGHTNESS_CONTRAST] },
  { id: 'focus', label: 'Focus', opacity: 200, types: [EffectType.BRIGHTNESS_CONTRAST, EffectType.DESATURATE] },
  { id: 'recede', label: 'Recede', opacity: 170, types: [EffectType.BRIGHTNESS_CONTRAST, EffectType.DESATURATE] },
  { id: 'midnight', label: 'Midnight', opacity: 200, types: [EffectType.BRIGHTNESS_CONTRAST, EffectType.COLORIZE] },
  { id: 'ghost', label: 'Ghost', opacity: 140, types: [EffectType.BRIGHTNESS_CONTRAST, EffectType.DESATURATE, EffectType.BLUR] },
  { id: 'dream', label: 'Dream', opacity: 220, types: [EffectType.BLUR, EffectType.COLORIZE] },

  // Lamp-style levels, each using its own parameter values rather than the
  // shared defaults. Level 1 leans brighter (an "attention" setting); Levels 2
  // and 3 step down into dim and grey.
  {
    id: 'lamp-1', label: 'Lamp · Level 1',
    opacity: 255,
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
    effects: [
      {
        type: EffectType.BRIGHTNESS_CONTRAST,
        brightness: [-0.1, -0.1, -0.1], contrast: [0, 0, 0]
      },
      { type: EffectType.DESATURATE, factor: 1.0 },
    ],
  },
];

// Turn a selection id (an EffectType value or a preset id) into a concrete
// plan: the effects to add plus the opacity to apply.
function resolveSelection(id) {
  if (id === EffectType.NONE)
    return { effects: [], opacity: DEFAULT_OPACITY, isNone: true };

  // Single-effect menu entry.
  if (EFFECT_TYPE_VALUES.has(id))
    return { effects: createEffects(id), opacity: DEFAULT_OPACITY, isNone: false };

  // Preset (combo) menu entry.
  const preset = PRESETS.find(p => p.id === id);
  if (!preset)
    return { effects: [], opacity: DEFAULT_OPACITY, isNone: true };

  let effects;
  if (preset.effects)
    effects = buildEffectsFromSpecs(preset.effects);
  else
    effects = (preset.types ?? []).flatMap(t => createEffects(t));

  return {
    effects,
    opacity: preset.opacity ?? DEFAULT_OPACITY,
    isNone: false,
  };
}

// --- Panel menu ---
const EffectMenuIndicator = GObject.registerClass(
  class EffectMenuIndicator extends PanelMenu.Button {
    _init(onSelect) {
      super._init(0.0, 'Window Effect', false);

      this._icon = new St.Icon({
        icon_name: 'applications-graphics-symbolic',
        style_class: 'system-status-icon'
      });
      this.add_child(this._icon);

      this._onSelect = onSelect;
      this._items = new Map(); // id -> PopupMenuItem

      // Existing single-effect entries.
      for (const [type, label] of EFFECT_LABELS) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.setOrnament(type === EffectType.NONE ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        item.connect('activate', () => this._select(type));
        this.menu.addMenuItem(item);
        this._items.set(type, item);
      }

      // Divider, then the presets.
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      for (const preset of PRESETS) {
        const item = new PopupMenu.PopupMenuItem(preset.label);
        item.setOrnament(PopupMenu.Ornament.NONE);
        item.connect('activate', () => this._select(preset.id));
        this.menu.addMenuItem(item);
        this._items.set(preset.id, item);
      }

      this._currentId = EffectType.NONE;
    }

    _select(id) {
      if (id === this._currentId) return;

      this._items.get(this._currentId)?.setOrnament(PopupMenu.Ornament.NONE);
      this._items.get(id)?.setOrnament(PopupMenu.Ornament.CHECK);
      this._currentId = id;

      this._onSelect(id);
    }
  });

export default class WindowEffectExtension extends Extension {
  _currentId = EffectType.NONE;
  _indicator = null;

  // Meta.WindowActor -> ClutterEffect[] (possibly empty for opacity-only
  // presets — an entry still exists so focus tracking knows it is affected).
  _effects = new Map();
  _focusedActor = null;

  _mapId = 0;
  _destroyId = 0;
  _focusChangedId = 0;

  enable() {
    this._mapId = global.window_manager.connect('map', (wm, actor) => this._onWindowMapped(actor));
    this._destroyId = global.window_manager.connect('destroy', (wm, actor) => this._onWindowDestroyed(actor));
    this._focusChangedId = global.display.connect('notify::focus-window', () => this._onFocusChanged());

    this._indicator = new EffectMenuIndicator((id) => this._applySelection(id));
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

    // add_effect_with_name() rather than add_effect(): Clutter's add_effect()
    // silently no-ops for repeated types, which would collapse the blur stack.
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
      if (this._focusedActor && this._focusedActor !== actor) {
        this._attachEffect(this._focusedActor);
      }
      this._focusedActor = actor;
    } else {
      this._attachEffect(actor);
    }
  }

  _onWindowDestroyed(actor) {
    this._effects.delete(actor); // effect is destroyed along with the actor
    if (this._focusedActor === actor) this._focusedActor = null;
  }

  _onFocusChanged() {
    if (this._currentId === EffectType.NONE) return;

    if (this._focusedActor) {
      this._attachEffect(this._focusedActor);
    }

    const focusWindow = global.display.focus_window;
    const newFocusedActor = focusWindow
      ? global.get_window_actors().find(a => a.get_meta_window() === focusWindow)
      : null;

    if (newFocusedActor) {
      this._detachEffect(newFocusedActor);
    }

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