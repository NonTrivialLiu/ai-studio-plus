/**
 * AI Studio Plus - Sidebar Multi-Select & Batch Delete
 * ISOLATED 世界。负责长按进入多选、选中状态渲染、键盘快捷键与批量删除确认流，
 * 包括搜索隐藏项计数与网络超时后的不确定项隔离。
 */
globalThis.__AIPSidebarParts = globalThis.__AIPSidebarParts || {};

globalThis.__AIPSidebarParts.createSelection = function createSelection(ctx) {
  const {
    LONG_PRESS_MS, LONG_PRESS_DISTANCE, TEXT, element, rowOf, linkOf, checkboxOf,
    isComposing, navigate, currentPromptId, positionPopup, requestAction
  } = globalThis.__AIPSidebarParts.shared;
  const { state, store } = ctx;

  function hiddenSelectedCount() {
    if (!state.selected.size || !state.view) return 0;
    const shown = new Set(state.view.groups.flatMap(group => group.items.map(item => item.id)));
    let hidden = 0;
    for (const id of state.selected) {
      if (!shown.has(id)) hidden += 1;
    }
    return hidden;
  }

  // 多选状态独立于当前会话；搜索只过滤显示，不改变选中的 ID。
  function renderSelection() {
    if (!state.root) return;
    state.root.classList.toggle('is-selecting', state.selecting);
    state.selectStart.hidden = state.selecting;
    state.selectStart.disabled = !state.view?.shown;
    state.selectionBar.hidden = !state.selecting;
    state.selectionCount.textContent = TEXT.selectedCount(state.selected.size, hiddenSelectedCount());
    state.selectionDelete.disabled = !state.selected.size || state.busy || state.uncertain.size > 0;
    state.selectionDelete.title = state.uncertain.size ? TEXT.uncertainTitle : '';
    state.selectionExit.disabled = state.busy;
    for (const [id, row] of state.rows) {
      const checkbox = checkboxOf(row);
      if (checkbox) {
        checkbox.checked = state.selected.has(id);
        checkbox.disabled = state.busy;
        checkbox.tabIndex = state.selecting ? 0 : -1;
      }
      const link = linkOf(row);
      if (link) link.tabIndex = state.selecting ? -1 : 0;
      if (state.uncertain.has(id)) row.dataset.uncertain = 'true';
      else delete row.dataset.uncertain;
    }
  }

  function enterSelection(id) {
    if (state.busy) return ctx.notice(TEXT.busy, 'error');
    if (state.edit) {
      ctx.edit.commitEdit(state.edit);
      return;
    }
    ctx.menu.closeMenu();
    state.selecting = true;
    if (id) state.selected.add(id);
    renderSelection();
    (id ? checkboxOf(state.rows.get(id)) : state.selectionExit)?.focus({ preventScroll: true });
  }

  function exitSelection() {
    if (state.busy) return;
    closeBatchDialog(false);
    state.selecting = false;
    state.selected.clear();
    state.uncertain.clear();
    renderSelection();
    (state.selectStart.disabled ? state.input : state.selectStart).focus({ preventScroll: true });
  }

  function setSelected(id, selected) {
    if (state.busy) return;
    if (selected) state.selected.add(id);
    else {
      state.selected.delete(id);
      state.uncertain.delete(id);
    }
    renderSelection();
  }

  // 长按达到阈值即选中；保留这次指针序列，直到松手或取消。
  function onPressStart(event) {
    if (state.selecting || state.edit || state.busy || event.button !== 0 || event.isPrimary === false ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !rowOf(event.target, '.aip-row-link')) return;
    cancelPress();
    const row = rowOf(event.target, '.aip-row');
    if (!row) return;
    const gesture = { row, pointerId: event.pointerId, x: event.clientX, y: event.clientY, activated: false };
    state.root.classList.add('is-pressing');
    row.classList.add('is-pressing');
    gesture.timer = setTimeout(() => {
      if (state.gesture !== gesture || !row.isConnected || state.selecting || state.edit || state.busy) return cancelPress();
      gesture.activated = true;
      state.root?.classList.remove('is-pressing');
      row.classList.remove('is-pressing');
      enterSelection(row.dataset.id);
    }, LONG_PRESS_MS);
    state.gesture = gesture;
  }

  function cancelPress() {
    const gesture = state.gesture;
    if (!gesture) return;
    clearTimeout(gesture.timer);
    gesture.row?.classList.remove('is-pressing');
    state.root?.classList.remove('is-pressing');
    state.gesture = null;
  }

  function onPressMove(event) {
    const gesture = state.gesture;
    if (gesture && !gesture.activated && event.pointerId === gesture.pointerId &&
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > LONG_PRESS_DISTANCE) cancelPress();
  }

  function onPressScroll() {
    if (state.gesture && !state.gesture.activated) cancelPress();
  }

  function onPressEnd(event) {
    const gesture = state.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (event.type === 'pointerup' && gesture.activated) {
      const suppressed = { pointerId: gesture.pointerId, row: gesture.row };
      state.suppressClick = suppressed;
      setTimeout(() => { if (state.suppressClick === suppressed) state.suppressClick = null; }, 700);
    }
    cancelPress();
  }

  function suppressLongPressClick(event) {
    const suppressed = state.suppressClick;
    if (!suppressed || event.detail === 0) return;
    const samePointer = typeof event.pointerId === 'number' && event.pointerId >= 0
      ? event.pointerId === suppressed.pointerId
      : event.composedPath().includes(suppressed.row);
    if (!samePointer) return;
    state.suppressClick = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onSelectionKeydown(event) {
    if (!state.selecting || isComposing(event)) return;
    if (event.key === 'Escape' && !state.busy) {
      event.preventDefault();
      exitSelection();
    } else if (event.key === 'Delete' && !event.target.matches('input:not([type="checkbox"]), textarea, [contenteditable="true"]') && !state.selectionDelete.disabled) {
      event.preventDefault();
      confirmBatchDelete();
    }
  }

  function closeBatchDialog(restoreFocus = true) {
    const dialog = state.batchDialog;
    if (!dialog) return;
    state.batchDialog = null;
    const refocus = restoreFocus && dialog.contains(document.activeElement) && state.selectionDelete?.isConnected;
    dialog.remove();
    if (refocus) state.selectionDelete.focus({ preventScroll: true });
  }

  // 确认框沿用单项删除的面板和按钮样式，明确包含被搜索隐藏的选择。
  function confirmBatchDelete() {
    if (!state.selecting || !state.selected.size || state.busy || state.uncertain.size || state.batchDialog) return;
    ctx.menu.closeMenu(undefined, false);
    const count = state.selected.size;
    const hidden = hiddenSelectedCount();
    const panel = element('div', 'aip-menu aip-batch-dialog');
    const title = element('div', 'aip-menu-confirm-title', TEXT.batchTitle(count));
    title.id = 'aip-batch-dialog-title';
    const desc = element('div', 'aip-menu-confirm-desc');
    desc.id = 'aip-batch-dialog-desc';
    desc.appendChild(element('div', 'aip-menu-confirm-text', count === 1 ? TEXT.confirmBody : TEXT.confirmBodies));
    if (hidden) desc.appendChild(element('div', 'aip-menu-confirm-text', TEXT.batchHidden(hidden)));
    if (state.selected.has(currentPromptId())) desc.appendChild(element('div', 'aip-menu-confirm-text', TEXT.batchOpenIncluded));

    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-labelledby', title.id);
    panel.setAttribute('aria-describedby', desc.id);

    const box = element('div', 'aip-menu-confirm');
    const actions = element('div', 'aip-menu-confirm-actions');
    const cancel = element('button', 'aip-menu-button', TEXT.confirmCancel);
    const remove = element('button', 'aip-menu-button aip-menu-button-danger', TEXT.confirmDelete);
    cancel.type = remove.type = 'button';
    cancel.dataset.action = 'cancel';
    remove.dataset.action = 'confirm';
    cancel.addEventListener('click', () => closeBatchDialog(true));
    remove.addEventListener('click', deleteSelected);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeBatchDialog(true);
      } else if (event.key === 'Tab' && (document.activeElement === cancel || document.activeElement === remove)) {
        event.preventDefault();
        (document.activeElement === cancel ? remove : cancel).focus();
      }
    });
    actions.append(cancel, remove);
    box.append(title, desc, actions);
    panel.appendChild(box);
    document.body.appendChild(panel);
    state.batchDialog = panel;
    positionPopup(panel, state.selectionDelete.getBoundingClientRect());
    cancel.focus({ preventScroll: true });
  }

  async function deleteSelected() {
    if (state.busy || !state.batchDialog) return;
    const ids = Array.from(state.selected);
    const active = currentPromptId();
    let removed = 0;
    let failed = 0;
    let removedActive = false;
    closeBatchDialog(false);
    state.busy = true;
    renderSelection();
    for (const [index, id] of ids.entries()) {
      state.selectionCount.textContent = TEXT.deletingProgress(index + 1, ids.length);
      const outcome = await requestAction(state, 'delete', { id });
      if (outcome.ok) {
        state.selected.delete(id);
        state.uncertain.delete(id);
        removed += 1;
        removedActive ||= id === active;
        store.remove(id);
      } else {
        failed += 1;
        if (outcome.code === 'timeout' || outcome.code === 'network') state.uncertain.add(id);
      }
    }
    state.busy = false;
    if (state.uncertain.size) store.refresh();
    if (removedActive) navigate('/library');
    if (!failed) {
      exitSelection();
      ctx.notice(TEXT.batchDeleted(removed), 'ok');
    } else {
      renderSelection();
      state.selectionExit.focus({ preventScroll: true });
      ctx.notice(
        state.uncertain.size ? TEXT.batchPartialUnknown(removed) : TEXT.batchPartialFailed(removed, failed),
        'error'
      );
    }
  }

  return {
    renderSelection, enterSelection, exitSelection, setSelected,
    onPressStart, onPressMove, cancelPress, onPressEnd, onPressScroll,
    suppressLongPressClick, onSelectionKeydown, closeBatchDialog, confirmBatchDelete, deleteSelected
  };
};
