/**
 * AI Studio Plus - Sidebar Inline Rename
 * ISOLATED 世界。负责历史会话行的原位重命名：双击 / F2 / 菜单触发，
 * Enter 提交、Esc 取消、失焦保存，并处理 IME 组字态与无标题会话重命名。
 */
globalThis.__AIPSidebarParts = globalThis.__AIPSidebarParts || {};

globalThis.__AIPSidebarParts.createEdit = function createEdit(ctx) {
  const {
    TEXT, element, linkOf, isComposing, currentPromptId, requestAction, failure, patchPageTitle
  } = globalThis.__AIPSidebarParts.shared;
  const { state, store } = ctx;

  function startEdit(row, select) {
    if (state.edit) {
      if (state.edit.row === row) return;
      commitEdit(state.edit);
      return;
    }
    ctx.menu.closeMenu();
    const id = row.dataset.id;
    const link = linkOf(row);
    if (!link) return;
    const input = element('input', 'aip-row-edit');
    input.type = 'text';
    input.value = link.title;
    input.setAttribute('aria-label', TEXT.rename);
    input.autocomplete = 'off';
    input.spellcheck = false;
    row.classList.add('is-editing');
    link.hidden = true;
    row.appendChild(input);
    const original = store.titleOf(id) ?? '';
    state.edit = { id, row, input, original, before: link.title, hadTitle: original !== '', saving: false };
    input.addEventListener('keydown', onEditKeydown);
    input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    input.focus({ preventScroll: true });
    if (select) input.select();
  }

  // 把一行恢复成普通行。之前它是否在保存不受影响：请求的结果回来后由 commitEdit 收尾。
  function teardownEdit(edit) {
    edit.input.remove();
    edit.row.classList.remove('is-editing');
    const link = linkOf(edit.row);
    if (link) link.hidden = false;
    ctx.syncRow(edit.row, { title: store.titleOf(edit.id) ?? edit.before });
  }

  function endEdit() {
    const edit = state.edit;
    if (!edit) return;
    const refocus = document.activeElement === edit.input;   // 只有焦点还在输入框里 (Enter / Esc) 才归还焦点
    state.edit = null;
    teardownEdit(edit);
    if (refocus) linkOf(edit.row)?.focus({ preventScroll: true });
  }

  function cancelEdit() {
    const edit = state.edit;
    if (!edit) return;
    store.rename(edit.id, edit.original);
    endEdit();
  }

  function onEditKeydown(event) {
    if (isComposing(event)) return;                          // 输入法组字选词：保持编辑状态
    if (state.edit?.saving) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit(state.edit);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  }

  function onEditBlur(event) {
    const edit = state.edit;
    if (edit && edit.input === event.target && !edit.saving) commitEdit(edit);
  }

  async function commitEdit(edit) {
    if (!edit || state.edit !== edit || edit.saving) return;
    const title = edit.input.value.replace(/\s+/g, ' ').trim();
    if (!title) {
      edit.input.setAttribute('aria-invalid', 'true');
      ctx.notice(TEXT.emptyTitle, 'error');
      return;
    }
    if (title === edit.before && edit.hadTitle) return endEdit();
    const wasOpen = currentPromptId() === edit.id;
    edit.saving = true;
    state.busy = true;
    edit.input.readOnly = true;
    edit.input.setAttribute('aria-busy', 'true');
    store.rename(edit.id, title);                              // 先按新标题显示
    const outcome = await requestAction(state, 'rename', { id: edit.id, title });
    state.busy = false;
    if (!outcome.ok) store.rename(edit.id, edit.original);     // 没保存成功：列表里改回原名
    if (state.edit !== edit) return;                           // 期间这一行已经退出了编辑
    edit.saving = false;
    edit.input.readOnly = false;
    edit.input.removeAttribute('aria-busy');
    if (outcome.ok) {
      if (wasOpen) patchPageTitle(edit.before, title);
      endEdit();
      ctx.notice(TEXT.renamed, 'ok');
    } else {
      ctx.notice(failure('rename', outcome.code), 'error');
    }
  }

  return { startEdit, teardownEdit, endEdit, cancelEdit, onEditKeydown, onEditBlur, commitEdit };
};
