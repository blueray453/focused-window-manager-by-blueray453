import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
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

export default class FocusedWindowManagerExtension extends Extension {

  enable() {

    initLogging(this.uuid, 'both', false);
    journal(`Enabled`);

    this._focusWindowChangedId = Display.connect('notify::focus-window', () => {
      this._animate_window_pop(Display.get_focus_window());
    });

    const reevaluate = () => this._schedule_focus_reevaluation();

    this._activeWorkspaceChangedId = WorkspaceManager.connect('active-workspace-changed', reevaluate);
    this._windowCreatedId = Display.connect('window-created', reevaluate);
    this._destroyId = WindowManager.connect('destroy', reevaluate);
    this._minimizeId = WindowManager.connect('minimize', reevaluate);
    this._unminimizeId = WindowManager.connect('unminimize', reevaluate);
    this._restackedId = Display.connect('restacked', reevaluate);
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

  _get_normal_windows_current_workspace(excludeAbove = false) {
    const currentWorkspace = WorkspaceManager.get_active_workspace();

    return Display.list_all_windows()
      .filter(win =>
        (win.get_window_type() === Meta.WindowType.NORMAL ||
          win.get_window_type() === Meta.WindowType.DIALOG) &&
        !win.is_skip_taskbar() &&
        (win.is_on_all_workspaces() || win.get_workspace() === currentWorkspace) &&
        !(excludeAbove && win.is_above())
      );
  }

  _is_covered(window, windows) {
    if (window.minimized)
      return false;

    const stacked = Display.sort_windows_by_stacking(windows);
    const targetIndex = stacked.indexOf(window);
    if (targetIndex === -1)
      return false;

    const targetRect = window.get_frame_rect();

    for (let i = targetIndex + 1; i < stacked.length; i++) {
      const topWin = stacked[i];
      if (topWin.minimized)
        continue;

      const topRect = topWin.get_frame_rect();
      if (topRect.x <= targetRect.x &&
        topRect.y <= targetRect.y &&
        topRect.x + topRect.width >= targetRect.x + targetRect.width &&
        topRect.y + topRect.height >= targetRect.y + targetRect.height)
        return true;
    }

    return false;
  }

  // ========= Ensure-focused logic ================ //

  _schedule_focus_reevaluation() {
    if (this._reevalId)
      return;

    this._reevalId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._reevalId = 0;
      this._ensure_focused_window();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Ensures the current workspace always has a sensible focused window:
  //   - exactly one window  -> unminimize, maximize, and focus it
  //   - a fullscreen window that's uncovered -> focus it
  //   - otherwise (side-by-side / overlapping windows) -> focus whichever
  //     window is topmost in the stack and not covered by anything else
  // "above" windows (e.g. pinned windows from another extension) are
  // excluded so one sitting on every workspace doesn't skew the count.
  _ensure_focused_window() {
    const windows = this._get_normal_windows_current_workspace(true);

    if (windows.length === 0)
      return;

    if (windows.length === 1) {
      const win = windows[0];

      if (win.minimized)
        win.unminimize();

      win.maximize(3);
      win.get_workspace().activate_with_focus(win, 0);
      return;
    }

    const visible = windows.filter(w => !w.minimized);
    if (visible.length === 0)
      return;

    const fullscreen = visible.find(w =>
      w.get_maximized() === Meta.MaximizeFlags.BOTH && !this._is_covered(w, visible));
    if (fullscreen) {
      fullscreen.get_workspace().activate_with_focus(fullscreen, 0);
      return;
    }

    const stacked = Display.sort_windows_by_stacking(visible);
    for (let i = stacked.length - 1; i >= 0; i--) {
      if (!this._is_covered(stacked[i], visible)) {
        stacked[i].get_workspace().activate_with_focus(stacked[i], 0);
        return;
      }
    }

    const top = stacked[stacked.length - 1];
    top.get_workspace().activate_with_focus(top, 0);
  }
}