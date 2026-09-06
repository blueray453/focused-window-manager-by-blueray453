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

// ========= Window queries ================ //
// Everything about "what windows exist / are visible / are covered" on the
// current workspace. No signals, no state - just answers questions when asked.
class WindowQuery {
  windowExistsOnCurrentWorkspace(win) {
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

  isEligible(win) {
    return this.windowExistsOnCurrentWorkspace(win) && !win.minimized;
  }

  windowsOnCurrentWorkspace() {
    return Display.list_all_windows().filter(win => this.windowExistsOnCurrentWorkspace(win));
  }

  isCoveredFullyOrPartially(window) {
    if (window.minimized) return false;

    let windows = Display.sort_windows_by_stacking(this.windowsOnCurrentWorkspace());

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
}

// ========= Animations ================ //
class WindowAnimations {
  constructor({ enabled = true, unfocusedOpacity = UNFOCUSED_OPACITY, fadeDuration = FADE_DURATION } = {}) {
    this.enabled = enabled;
    this._unfocusedOpacity = unfocusedOpacity;
    this._fadeDuration = fadeDuration;
    this._dimmedActors = new Set();
  }

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
class FocusedBorder {
  constructor(query) {
    this._query = query;
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

    if (!this._query.isEligible(win)) {
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

// ========= Focus policy ================ //
// Owns "which window on this workspace should be focused, and how" -
// including its own debounce. The extension class never sees this
// machinery; it just calls schedule() / restoreLoneMinimizedWindow().
class FocusPolicy {
  constructor(query, animations, border) {
    this._query = query;
    this._animations = animations;
    this._border = border;
    this._scheduleId = 0;
  }

  // Debounced: call from any signal that might mean the workspace's
  // window layout changed. Coalesces bursts into one run.
  schedule() {
    if (this._scheduleId)
      return;

    this._scheduleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._scheduleId = 0;
      this._apply();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Synchronous, called only on workspace switch, before schedule() runs.
  // If this workspace has exactly one window and it's minimized, restore
  // it - by the time the debounced schedule() fires, it's an ordinary
  // single window and gets maximized/focused through the normal path.
  restoreLoneMinimizedWindow() {
    const allWindows = this._query.windowsOnCurrentWorkspace();
    if (allWindows.length !== 1)
      return;

    const win = allWindows[0];
    if (!win.minimized)
      return;

    win.unminimize();
    this._animations.reveal(win);
  }

  _apply() {
    const allWindows = this._query.windowsOnCurrentWorkspace();
    if (allWindows.length === 0) return;

    const visible = allWindows.filter(w => !w.minimized);

    if (allWindows.length === 1) {
      const win = allWindows[0];
      if (win.minimized) return;

      const wasMaximized = win.get_maximized() === Meta.MaximizeFlags.BOTH;
      if (!wasMaximized) win.maximize(3);

      win.get_workspace().activate_with_focus(win, global.get_current_time());
      this._animations.clearDimmed();

      if (!wasMaximized)
        this._animations.reveal(win);

      this._border.update();
      return;
    }

    if (visible.length === 0) return;

    const uncovered = visible.filter(w => !this._query.isCoveredFullyOrPartially(w));
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

  destroy() {
    if (this._scheduleId) {
      GLib.Source.remove(this._scheduleId);
      this._scheduleId = 0;
    }
  }
}

export default class FocusedWindowManagerExtension extends Extension {

  enable() {
    initLogging(this.uuid, 'both', false);
    journal(`Enabled`);

    this._query = new WindowQuery();
    this._animations = new WindowAnimations();
    this._border = new FocusedBorder(this._query);
    this._focusPolicy = new FocusPolicy(this._query, this._animations, this._border);

    this._focusWindowChangedId = Display.connect('notify::focus-window', () => {
      const win = Display.get_focus_window();

      if (this._query.isEligible(win)) {
        const others = this._query.windowsOnCurrentWorkspace()
          .filter(w => w !== win && this._query.isEligible(w));
        this._animations.focusChanged(win, others);
      }

      this._border.update();
    });

    this._activeWorkspaceChangedId = WorkspaceManager.connect('active-workspace-changed', () => {
      this._focusPolicy.restoreLoneMinimizedWindow();
      this._focusPolicy.schedule();
      this._border.update();
    });

    this._windowCreatedId = Display.connect('window-created', () => {
      this._focusPolicy.schedule();
      this._border.scheduleUpdate();
    });

    this._destroyId = WindowManager.connect('destroy', (wm, actor) => {
      this._border.removeIfActorMatches(actor);
      this._focusPolicy.schedule();
      this._border.update();
    });

    this._minimizeId = WindowManager.connect('minimize', (wm, actor) => {
      this._focusPolicy.schedule();
      this._border.removeIfActorMatches(actor);
    });

    this._unminimizeId = WindowManager.connect('unminimize', () => {
      this._focusPolicy.schedule();
      this._border.update();
    });

    this._restackedId = Display.connect('restacked', () => {
      this._focusPolicy.schedule();
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

    this._animations.clearDimmed();
    this._border.destroy();
    this._focusPolicy.destroy();
  }
}