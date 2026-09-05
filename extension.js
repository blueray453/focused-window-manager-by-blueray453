import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const Display = global.get_display();
const WindowManager = global.get_window_manager();
const WorkspaceManager = global.get_workspace_manager();

import {
  initLogging,
    createLogger,
    } from './logger.js';

const journal = createLogger(import.meta.url);

const FOCUSED_BORDER_CLASS = 'focused-border';

export default class FocusedWindowManagerExtension extends Extension {

  enable() {
    initLogging(this.uuid, 'both', false);
    journal(`Enabled`);

    this._focusedBorder = null;
    this._focusedBorderActor = null;
    this._focusedWindowSignals = [];
    this._borderUpdateId = 0;

    this._focusWindowChangedId = Display.connect('notify::focus-window', () => {
      const win = Display.get_focus_window();

      if (this._is_eligible_window(win)){
        this._animate_window_pop(win);
      }
      this._update_focused_border();
    });

    const reevaluate = () => this._schedule_focus_reevaluation();

    this._activeWorkspaceChangedId = WorkspaceManager.connect('active-workspace-changed', () => {
      reevaluate();
      this._update_focused_border();
    });
    this._windowCreatedId = Display.connect('window-created', win => {
      reevaluate();

      // A newly created window can become focused before the next idle pass.
      // Refresh the border once the compositor actor exists.
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._update_focused_border();
        return GLib.SOURCE_REMOVE;
      });
    });
    this._destroyId = WindowManager.connect('destroy', (wm, actor) => {
      if (actor === this._focusedBorderActor)
        this._remove_focused_border();

      reevaluate();
      this._update_focused_border();
    });
    this._minimizeId = WindowManager.connect('minimize', (wm, actor) => {
      reevaluate();

      if (actor === this._focusedBorderActor)
        this._remove_focused_border();
    });

    this._unminimizeId = WindowManager.connect('unminimize', () => {
      reevaluate();
      this._update_focused_border();
    });

    this._restackedId = Display.connect('restacked', () => {
      reevaluate();
      this._restack_focused_border();
    });

    this._update_focused_border();
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

    if (this._borderUpdateId) {
      GLib.Source.remove(this._borderUpdateId);
      this._borderUpdateId = 0;
    }

    this._disconnect_focused_window_signals();
    this._remove_focused_border();
  }

  // ========= Focused-window border ================ //

  _disconnect_focused_window_signals() {
    const win = this._focusedBorderActor?.get_meta_window();

    if (win) {
      for (const id of this._focusedWindowSignals) {
        if (id)
          win.disconnect(id);
      }
    }

    this._focusedWindowSignals = [];
  }

  _schedule_focused_border_update() {
    if (this._borderUpdateId)
      return;

    this._borderUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._borderUpdateId = 0;
      this._update_focused_border();
      return GLib.SOURCE_REMOVE;
    });
  }

  _remove_focused_border() {
    this._disconnect_focused_window_signals();

    if (this._focusedBorder?.get_parent())
      this._focusedBorder.get_parent().remove_child(this._focusedBorder);

    if (this._focusedBorder) {
      this._focusedBorder.destroy();
      this._focusedBorder = null;
    }

    this._focusedBorderActor = null;
  }

  _restack_focused_border() {
    const border = this._focusedBorder;
    const actor = this._focusedBorderActor;

    if (!border || !actor || !border.get_parent())
      return;

    const windowGroup = global.get_window_group();
    windowGroup.set_child_above_sibling(border, actor);
  }

  _update_focused_border() {
    const win = Display.get_focus_window();

    if (!this._is_eligible_window(win)) {
      this._remove_focused_border();
      return;
    }

    const actor = win.get_compositor_private();

    if (!actor || !actor.get_parent()) {
      this._remove_focused_border();
      return;
    }

    if (this._focusedBorderActor !== actor) {
      this._remove_focused_border();

      this._focusedBorder = new St.Bin({
        style_class: FOCUSED_BORDER_CLASS,
        reactive: false,
      });

      this._focusedBorderActor = actor;

      // Keep the border synchronized with every geometry change. This mirrors
      // taggedWindowFunctions.js, which listens to position-changed and
      // size-changed so the border follows moves, resizes, and maximization.
      const update = () => this._schedule_focused_border_update();
      this._focusedWindowSignals = [
        win.connect('position-changed', update),
        win.connect('size-changed', update),
        win.connect('workspace-changed', update),
      ];

      actor.get_parent().add_child(this._focusedBorder);
      this._restack_focused_border();
    }

    const rect = win.get_frame_rect();
    this._focusedBorder.set_position(rect.x, rect.y);
    this._focusedBorder.set_size(rect.width, rect.height);

    this._restack_focused_border();
  }

  // ========= Animation ================ //

  _animate_window_pop(win) {
    if (!win)
      return;

    const actor = win.get_compositor_private();
    if (!actor)
      return;

    actor.set_pivot_point(0.5, 0.5);
    actor.remove_all_transitions();
    actor.set_scale(0.96, 0.96);
    actor.ease({
      scale_x: 1,
      scale_y: 1,
      duration: 220,
      mode: Clutter.AnimationMode.EASE_OUT_BACK,
    });
  }

  // ========= Window queries (self-contained, no shared helper file) ============ //

  _is_eligible_window(win) {
    if (!win) return false;
    if (win.minimized) return false;  // optional: we often filter minimized separately, but it's safe here

    const type = win.get_window_type();
    if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG)
      return false;

    if (win.is_skip_taskbar())
      return false;

    // Workspace check
    const currentWorkspace = WorkspaceManager.get_active_workspace();
    const winWorkspace = win.get_workspace();
    if (!winWorkspace) return false; // rare, but safe
    if (!win.is_on_all_workspaces() && winWorkspace !== currentWorkspace)
      return false;

    return true;
  }

  _get_normal_windows_current_workspace() {
    return Display.list_all_windows().filter(win => this._is_eligible_window(win));
  }

  _schedule_focus_reevaluation() {
    if (this._reevalId)
      return;

    this._reevalId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._reevalId = 0;
      this._ensure_focused_window();
      return GLib.SOURCE_REMOVE;
    });
  }

  _window_matches(window, predicate) {
    if (window.minimized)
      return false;

    let windows = Display.sort_windows_by_stacking(
      this._get_normal_windows_current_workspace()
    );

    let targetIndex = windows.indexOf(window);
    if (targetIndex === -1)
      return false;

    let targetRect = window.get_frame_rect();

    // Check only windows above the target
    for (let i = targetIndex + 1; i < windows.length; i++) {
      let topWin = windows[i];

      if (topWin.minimized)
        continue;

      let topRect = topWin.get_frame_rect();

      if (predicate(targetRect, topRect))
        return true;
    }

    return false;
  }

  _is_covered_partially(window) {
    return this._window_matches(window, (target, top) =>
      target.x < top.x + top.width &&
      target.x + target.width > top.x &&
      target.y < top.y + top.height &&
      target.y + target.height > top.y
    );
  }

  _ensure_focused_window() {
    const allWindows = this._get_normal_windows_current_workspace();
    if (allWindows.length === 0) return;

    // Case 1: Single window
    if (allWindows.length === 1) {
      const win = allWindows[0];
      if (win.minimized) win.unminimize();
      win.maximize(3);
      win.get_workspace().activate_with_focus(win, 0);
      this._update_focused_border();
      return;
    }

    // Case 2: Multiple windows
    const visible = allWindows.filter(w => !w.minimized);
    if (visible.length === 0) return;

    // Keep only windows that are NOT partially covered by any window above them
    const uncovered = visible.filter(w => !this._is_covered_partially(w));

    // Should never be empty because the absolute topmost is always uncovered
    if (uncovered.length === 0) return;

    let target;
    if (uncovered.length === 1) {
      // Only one fully visible window → focus it
      target = uncovered[0];
    } else {
      target = uncovered.reduce((a, b) =>
        a.get_user_time() > b.get_user_time() ? a : b
      );
    }

    target.get_workspace().activate_with_focus(target, 0);
    this._update_focused_border();
  }
}