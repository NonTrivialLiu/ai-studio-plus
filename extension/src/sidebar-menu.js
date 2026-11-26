/**
 * AI Studio Plus - Sidebar Context Menu
 * ISOLATED 世界。负责行尾三点菜单、菜单定位、单项删除确认弹窗、
 * 焦点迁移以及复用 History 页的分享动作。
 */
globalThis.__AIPSidebarParts = globalThis.__AIPSidebarParts || {};

globalThis.__AIPSidebarParts.createMenu = function createMenu(ctx) {
  const {
    MENU, SHARE_WAIT_MS, TEXT, element, icon, delay, rowOf, linkOf, menuButtonOf, rowTitle,
    navigate, currentPromptId, positionPopup, requestAction, failure
  } = globalThis.__AIPSidebarParts.shared;
  const { state, store } = ctx;

  function openMenu(row, anchor) {
    if (state.menu && state.menu.row === row) return closeMenu();
    closeMenu();
    ctx.selection.closeBatchDialog(false);
    const button = menuButtonOf(row);
    if (!button) return;
    const panel = element('div', 'aip-menu');
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', TEXT.menu);
    for (const item of MENU) {
      const entry = element('button', 'aip-menu-item');
      entry.type = 'button';
      entry.tabIndex = -1;               // 菜单内用方向键移动，见下面的 keydown
      entry.setAttribute('role', 'menuitem');
      entry.dataset.action = item.action;
      entry.append(icon(item.icon, 'aip-menu-icon'), element('span', 'aip-menu-text', item.label));
      panel.appendChild(entry);
    }
    panel.addEventListener('click', event => {
      const entry = rowOf(event.target, '[data-action]');
      if (!entry) return;
      const action = entry.dataset.action;
      if (action === 'delete') return renderConfirm();
      if (action === 'cancel') return closeMenu(undefined, true);
      runMenuAction(action === 'confirm' ? 'delete' : action);
    });
    panel.addEventListener('keydown', event => {
      const isConfirm = panel.getAttribute('role') === 'alertdialog';
      const entries = Array.from(panel.querySelectorAll('[data-action]'));
      const index = entries.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(undefined, true);
      } else if (!isConfirm && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        entries[(index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus();
      } else if (event.key === 'Tab') {
        if (isConfirm && entries.length >= 2) {
          event.preventDefault();
          const next = event.shiftKey ? (index <= 0 ? entries.length - 1 : index - 1) : (index + 1) % entries.length;
          entries[next]?.focus();
        } else {
          closeMenu(undefined, false);  // 焦点就要移出面板：收起菜单，不拦 Tab
        }
      }
    });
    document.body.appendChild(panel);
    state.menu = { panel, row, button, id: row.dataset.id, title: rowTitle(row), anchor };
    button.setAttribute('aria-expanded', 'true');
    positionMenu();
    panel.firstElementChild.focus({ preventScroll: true });
  }

  function positionMenu() {
    if (!state.menu) return;
    positionPopup(state.menu.panel, state.menu.anchor);
  }

  // 关闭菜单。row 给定时只关这一行的菜单；focus=false 用于焦点本来就要去别处的情况。
  function closeMenu(row, focus = true) {
    const menu = state.menu;
    if (!menu || (row && menu.row !== row)) return;
    state.menu = null;
    const refocus = focus && menu.panel.contains(document.activeElement) && menu.button.isConnected;
    menu.button.setAttribute('aria-expanded', 'false');
    menu.panel.remove();
    if (refocus) menu.button.focus({ preventScroll: true });
  }

  // 删除要确认：面板切换为 alertdialog，焦点默认落在"取消"上，回车不会误删。
  function renderConfirm() {
    const menu = state.menu;
    if (!menu) return;
    const title = element('div', 'aip-menu-confirm-title', TEXT.confirmTitle);
    title.id = 'aip-menu-confirm-title';
    const body = element('div', 'aip-menu-confirm-text', TEXT.confirmBody);
    body.id = 'aip-menu-confirm-desc';
    menu.panel.setAttribute('role', 'alertdialog');
    menu.panel.removeAttribute('aria-label');
    menu.panel.setAttribute('aria-labelledby', title.id);
    menu.panel.setAttribute('aria-describedby', body.id);

    const box = element('div', 'aip-menu-confirm');
    const actions = element('div', 'aip-menu-confirm-actions');
    const cancel = element('button', 'aip-menu-button', TEXT.confirmCancel);
    const remove = element('button', 'aip-menu-button aip-menu-button-danger', TEXT.confirmDelete);
    cancel.type = remove.type = 'button';
    cancel.dataset.action = 'cancel';
    remove.dataset.action = 'confirm';
    actions.append(cancel, remove);
    box.append(title, element('div', 'aip-menu-confirm-name', menu.title), body, actions);
    menu.panel.replaceChildren(box);
    positionMenu();
    cancel.focus({ preventScroll: true });
  }

  async function runMenuAction(action) {
    const menu = state.menu;
    if (!menu) return;
    const { id, row, title } = menu;
    closeMenu();                         // 焦点回到行尾的三点按钮
    if (action === 'rename') return ctx.edit.startEdit(row, true);
    if (action === 'share') return shareChat(row);
    if (action === 'select') return ctx.selection.enterSelection(id);
    if (action !== 'copy' && action !== 'delete') return;
    if (state.busy) return ctx.notice(TEXT.busy, 'error');
    state.busy = true;
    const outcome = action === 'copy'
      ? await requestAction(state, 'copy', { id, title: `${TEXT.copyPrefix}${title}` })
      : await requestAction(state, 'delete', { id });
    state.busy = false;
    if (!outcome.ok) return ctx.notice(failure(action, outcome.code), 'error');
    if (action === 'copy') return ctx.notice(TEXT.copied, 'ok');
    focusNeighbor(row);
    store.remove(id);
    ctx.notice(TEXT.deleted, 'ok');
    if (currentPromptId() === id) navigate('/library');     // 官方行为：删掉当前会话后回到 History 页
  }

  // 某一行要消失时，把键盘焦点挪到相邻的一行上。
  function focusNeighbor(row) {
    const rows = Array.from(state.scroll.querySelectorAll('.aip-row:not([hidden])'));
    const index = rows.indexOf(row);
    linkOf(rows[index + 1] || rows[index - 1])?.focus({ preventScroll: true });
  }

  // 复用 History 中目标会话的分享入口，打开 Google Drive 的共享对话框。
  async function shareChat(row) {
    const id = row.dataset.id;
    navigate('/library');
    const deadline = Date.now() + SHARE_WAIT_MS;
    while (Date.now() < deadline) {
      if (location.pathname !== '/library') break;
      const link = document.querySelector(`tr a[href="/prompts/${id}"]`);
      const more = link?.closest('tr')?.querySelector('button[aria-label="More options"]');
      if (more) {
        more.click();
        await delay(100);
        if (location.pathname !== '/library') break;
        const entry = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .find(node => node.textContent.trim().replace(/\s+/g, ' ').endsWith('Share') && node.getBoundingClientRect().width);
        if (entry && !entry.disabled && entry.getAttribute('aria-disabled') !== 'true') return entry.click();
        break;
      }
      await delay(200);
    }
    ctx.notice(TEXT.failed.share, 'error');
  }

  return { openMenu, closeMenu, positionMenu, renderConfirm, runMenuAction, focusNeighbor, shareChat };
};
