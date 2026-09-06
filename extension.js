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
  createLogger,
} from './logger.js';

const journal = createLogger(import.meta.url);

const FOCUSED_BORDER_CLASS = 'focused-border';

// ========= Animations ================ //
// Every visual effect the extension plays lives here. Set `enabled = false`
// on an instance (or delete calls into it) to kill all animation without
// touching any focus-tracking logic elsewhere.
class WindowAnimations {
  constructor({ enabled = true, unfocusedOpacity = UNFOCUSED_OPACITY, fadeDuration = FADE_DURATION } = {}) {
    this.enabled = enabled;
    this._unfocusedOpacity = unfocusedOpacity;
    this._fadeDuration = fadeDuration;
    this._dimmedActors = new Set();
  }

  // Called on every focus change: brings `win` to full opacity and dims
  // every window in `others`.
  focusChanged(win, others) {
    const focusedActor = win?.get_compositor_private();
    if (!focusedActor)
      return;

    if (!this.enabled) {
      this.clearDimmed();
      return;
    }

    focusedActor.remove_all_transitions();
    focusedActor.ease({
      opacity: 255,
      duration: this._fadeDuration,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
    this._dimmedActors.delete(focusedActor);

    for (const otherWin of others) {
      const actor = otherWin.get_compositor_private();
      if (!actor)
        continue;

      actor.remove_all_transitions();
      actor.ease({
        opacity: this._unfocusedOpacity,
        duration: this._fadeDuration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
      this._dimmedActors.add(actor);
    }
  }

  // Restores full opacity on everything currently dimmed.
  clearDimmed() {
    for (const actor of this._dimmedActors) {
      actor.remove_all_transitions();
      actor.ease({
        opacity: 255,
        duration: this._fadeDuration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    }
    this._dimmedActors.clear();
  }

  // Scale-in reveal, used identically whether a window was just maximized
  // or just restored from minimized - both are "this window just became
  // the visible one" and should feel the same.
  reveal(win) {
    if (!this.enabled)
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
      duration: this._fadeDuration,
      mode: Clutter.AnimationMode.EASE_OUT,
    });
  }
}

// ========= Focused-window border ================ //
// Owns the single border actor, its parenting/restacking, and the signals
// that keep it glued to whichever window currently has focus.
class FocusedBorder {
  constructor(isEligibleFn) {
    this._isEligible = isEligibleFn;
    this._border = null;
    this._actor = null;
    this._signals = [];
    this._updateId = 0;
  }

  _disconnectSignals() {
    const win = this._actor?.get_meta_window();

    if (win) {
      for (const id of this._signals) {
        if (id)
          win.disconnect(id);
      }
    }

    this._signals = [];
  }

  scheduleUpdate() {
    if (this._updateId)
      return;

    this._updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._updateId = 0;
      this.update();
      return GLib.SOURCE_REMOVE;
    });
  }

  remove() {
    this._disconnectSignals();

    if (this._border?.get_parent())
      this._border.get_parent().remove_child(this._border);
    if (this._border) {
      this._border.destroy();
      this._border = null;
    }

    this._actor = null;
  }

  // Removes the border only if it currently belongs to `actor` - used from
  // 'destroy'/'minimize' handlers that only know the actor, not whether
  // it's the one wearing the border.
  removeIfActorMatches(actor) {
    if (actor === this._actor)
      this.remove();
  }

  restack() {
    if (!this._border || !this._actor || !this._border.get_parent())
      return;

    global.get_window_group().set_child_above_sibling(this._border, this._actor);
  }

  update() {
    const win = Display.get_focus_window();

    if (!this._isEligible(win)) {
      this.remove();
      return;
    }

    const actor = win.get_compositor_private();

    if (!actor || !actor.get_parent()) {
      this.remove();
      return;
    }

    if (this._actor !== actor) {
      this.remove();

      this._border = new St.Bin({
        style_class: FOCUSED_BORDER_CLASS,
        reactive: false,
      });
      this._actor = actor;

      const onGeometryChanged = () => this.scheduleUpdate();
      this._signals = [
        win.connect('position-changed', onGeometryChanged),
        win.connect('size-changed', onGeometryChanged),
        win.connect('workspace-changed', onGeometryChanged),
      ];

      actor.get_parent().add_child(this._border);
      this.restack();
    }

    const rect = win.get_frame_rect();
    this._border.set_position(rect.x, rect.y);
    this._border.set_size(rect.width, rect.height);
    this.restack();
  }

  destroy() {
    if (this._updateId) {
      GLib.Source.remove(this._updateId);
      this._updateId = 0;
    }
    this.remove();
  }
}

export default class FocusedWindowManagerExtension extends Extension {

  enable() {
    initLogging(this.uuid, 'both', false);
    journal(`Enabled`);

    this._animations = new WindowAnimations();
    this._border = new FocusedBorder(win => this._is_eligible_window(win));
    this._reevalRestoreMinimized = false;
    this._lastSoloWindow = null;

    this._focusWindowChangedId = Display.connect('notify::focus-window', () => {
      const win = Display.get_focus_window();

      if (this._is_eligible_window(win)) {
        const others = this._get_normal_windows_current_workspace()
          .filter(w => w !== win && this._is_eligible_window(w));
        this._animations.focusChanged(win, others);
      }

      this._border.update();
    });

    const reevaluate = (options) => this._schedule_focus_reevaluation(options);

    this._activeWorkspaceChangedId = WorkspaceManager.connect('active-workspace-changed', () => {
      reevaluate({ restoreMinimized: true }); // arriving on this workspace should restore a lone minimized window
      this._border.update();
    });

    this._windowCreatedId = Display.connect('window-created', win => {
      if (this._window_exists_on_current_workspace(win))
        reevaluate();

      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._border.update();
        return GLib.SOURCE_REMOVE;
      });
    });

    this._destroyId = WindowManager.connect('destroy', (wm, actor) => {
      this._border.removeIfActorMatches(actor);
      reevaluate();
      this._border.update();
    });
    this._minimizeId = WindowManager.connect('minimize', (wm, actor) => {
      reevaluate();
      this._border.removeIfActorMatches(actor);
    });

    this._unminimizeId = WindowManager.connect('unminimize', () => {
      reevaluate();
      this._border.update();
    });

    this._restackedId = Display.connect('restacked', () => {
      reevaluate();
      this._border.restack();
    });

    this._border.update();
  }

  disable() {
    for (const [obj, id] of [
      [Display, this._focusWindowChangedId],
      [WorkspaceManager, this._activeWorkspaceChangedId],
      [Display, this._windowCreatedId],
      [WindowManager, this._destroyId],
      [WindowManager, this._minimizeId],
      [WindowManager, this._unminimizeId],
      [Display, this._restackedId],
    ]) {
      if (id)
        obj.disconnect(id);
    }

    this._focusWindowChangedId = null;
    this._activeWorkspaceChangedId = null;
    this._windowCreatedId = null;
    this._destroyId = null;
    this._minimizeId = null;
    this._unminimizeId = null;
    this._restackedId = null;

    if (this._reevalId) {
      GLib.Source.remove(this._reevalId);
      this._reevalId = 0;
    }

    this._animations.clearDimmed();
    this._border.destroy();
  }

  // ========= Window queries (self-contained, no shared helper file) ============ //

  _window_exists_on_current_workspace(win) {
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

  _is_eligible_window(win) {
    return this._window_exists_on_current_workspace(win) && !win.minimized;
  }

  _get_normal_windows_current_workspace() {
    return Display.list_all_windows().filter(win => this._window_exists_on_current_workspace(win));
  }

  _schedule_focus_reevaluation(options = {}) {
    // OR'd across calls: if any trigger in this debounce window asked for a
    // restore (i.e. a workspace switch happened), honor it even if a plain
    // minimize/restack also fired in the same burst.
    this._reevalRestoreMinimized = this._reevalRestoreMinimized || !!options.restoreMinimized;

    if (this._reevalId)
      return;

    this._reevalId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._reevalId = 0;
      const restoreMinimized = this._reevalRestoreMinimized;
      this._reevalRestoreMinimized = false;
      this._ensure_focused_window(restoreMinimized);
      return GLib.SOURCE_REMOVE;
    });
  }

  _is_covered_fully_or_partially(window) {
    if (window.minimized) return false;

    let windows = Display.sort_windows_by_stacking(
      this._get_normal_windows_current_workspace()
    );

    let targetIndex = windows.indexOf(window);
    if (targetIndex === -1) return false;

    let targetRect = window.get_frame_rect();

    let monitor = window.get_monitor();
    let workArea = WorkspaceManager.get_active_workspace().get_work_area_for_monitor(monitor);

    let clippedTarget = {
      x: Math.max(targetRect.x, workArea.x),
      y: Math.max(targetRect.y, workArea.y),
      width: 0,
      height: 0
    };
    let targetRight = Math.min(targetRect.x + targetRect.width, workArea.x + workArea.width);
    let targetBottom = Math.min(targetRect.y + targetRect.height, workArea.y + workArea.height);
    clippedTarget.width = targetRight - clippedTarget.x;
    clippedTarget.height = targetBottom - clippedTarget.y;

    if (clippedTarget.width <= 0 || clippedTarget.height <= 0) return false;

    for (let i = targetIndex + 1; i < windows.length; i++) {
      let topWin = windows[i];
      if (topWin.minimized) continue;

      let topRect = topWin.get_frame_rect();

      let clippedTop = {
        x: Math.max(topRect.x, workArea.x),
        y: Math.max(topRect.y, workArea.y),
        width: 0,
        height: 0
      };
      let topRight = Math.min(topRect.x + topRect.width, workArea.x + workArea.width);
      let topBottom = Math.min(topRect.y + topRect.height, workArea.y + workArea.height);
      clippedTop.width = topRight - clippedTop.x;
      clippedTop.height = topBottom - clippedTop.y;

      if (clippedTop.width <= 0 || clippedTop.height <= 0) continue;

      if (clippedTarget.x < clippedTop.x + clippedTop.width &&
        clippedTarget.x + clippedTarget.width > clippedTop.x &&
        clippedTarget.y < clippedTop.y + clippedTop.height &&
        clippedTarget.y + clippedTarget.height > clippedTop.y) {
        return true;
      }
    }

    return false;
  }

  _ensure_focused_window(restoreMinimized = false) {
    const allWindows = this._get_normal_windows_current_workspace();

    if (allWindows.length === 0) return;

    const visible = allWindows.filter(w => !w.minimized);

    if (allWindows.length === 1) {
      const win = allWindows[0];

      // Did this window just become the workspace's sole window, or has it
      // already been the sole window across previous (possibly ambient,
      // e.g. a menu popup's window-created/restacked) reevaluations?
      const isNewSoloState = this._lastSoloWindow !== win;
      this._lastSoloWindow = win;

      // Respect a deliberate minimize unless this run came from a
      // workspace switch (restoreMinimized) - a switch should always
      // restore a lone minimized window.
      if (win.minimized && !restoreMinimized)
        return;

      const wasMinimized = win.minimized;
      if (wasMinimized)
        win.unminimize();

      const wasMaximized = win.get_maximized() === Meta.MaximizeFlags.BOTH;

      // Only force a maximize on a genuine transition into solo state, or
      // on workspace-switch arrival. An ambient rerun (menu popup causing
      // window-created/restacked) for a window already settled here must
      // never re-force a maximize the user deliberately undid.
      const shouldForceMaximize = isNewSoloState || restoreMinimized;

      if (!wasMaximized && shouldForceMaximize)
        win.maximize(3);

      win.get_workspace().activate_with_focus(win, global.get_current_time());
      this._animations.clearDimmed();

      if (wasMinimized || (!wasMaximized && shouldForceMaximize))
        this._animations.reveal(win);

      this._border.update();
      return;
    }

    this._lastSoloWindow = null; // not alone anymore - next time it's solo, treat it as new

    if (visible.length === 0) return;

    const uncovered = visible.filter(w => !this._is_covered_fully_or_partially(w));
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
    this._border.update();
  }
}