(() => {
  const users = Array.from(document.querySelectorAll('ms-chat-turn > .chat-turn-container.user'));
  const failures = [];
  let loaded = 0;
  let visible = 0;
  for (const user of users) {
    const content = user.querySelector('.turn-content');
    const hasContent = !!content && (content.textContent.trim().length > 0 ||
      !!content.querySelector('img, video, canvas, audio, textarea, [contenteditable="true"]'));
    const style = getComputedStyle(user);
    const rect = user.getBoundingClientRect();
    if (hasContent) loaded++;
    if (rect.bottom > 0 && rect.top < innerHeight) visible++;
    const id = user.closest('ms-chat-turn').id;
    if (!hasContent && (user.hasAttribute('data-aib-ready') || style.filter !== 'none')) {
      failures.push({ id, error: 'Empty message painted as a bubble' });
    }
    if (hasContent && !user.hasAttribute('data-aib-ready')) {
      failures.push({ id, error: 'Loaded message not styled' });
    }
    if (user.querySelectorAll('.aib-toggle').length !== 1) {
      failures.push({ id, error: 'Missing or duplicate toggle' });
    }
  }
  const sidebar = document.querySelector('#aip-history');
  const drawer = document.querySelector('.aip-drawer');
  const rows = sidebar ? Array.from(sidebar.querySelectorAll('.aip-row')) : [];
  const sidebarFailures = [];
  if (!sidebar) sidebarFailures.push('History sidebar missing');
  if (!drawer) sidebarFailures.push('Drawer missing');
  if (rows.some(row => !row.querySelector('.aip-row-link') || !row.querySelector('.aip-row-menu'))) {
    sidebarFailures.push('Chat row missing link or menu');
  }
  return {
    pass: users.length > 0 && failures.length === 0 && sidebarFailures.length === 0,
    users: users.length, loaded, visible, failures,
    sidebar: {
      mounted: !!sidebar,
      rows: rows.length,
      active: rows.filter(row => row.querySelector('[aria-current="page"]')).length,
      drawerExpanded: drawer?.getAttribute('aria-expanded') ?? null,
      failures: sidebarFailures
    }
  };
})()
