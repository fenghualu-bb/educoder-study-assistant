(() => {
  const modes = new Set(['system', 'light', 'dark']);
  const select = document.querySelector('#appearance-mode');
  const bridge = window.studyAppearance;
  let revision = 0;
  const apply = mode => {
    if (!modes.has(mode)) return;
    document.documentElement.dataset.theme = mode;
    if (select) select.value = mode;
  };
  const readFallback = () => { try { return localStorage.getItem('educoder.appearance.v1') ?? 'system'; } catch { return 'system'; } };
  apply('system');
  const initial = revision;
  if (bridge) bridge.get().then(mode => { if (initial === revision) apply(mode); }).catch(() => { if (initial === revision) apply('system'); });
  else apply(readFallback());
  bridge?.onChanged(mode => { ++revision; apply(mode); });
  select?.addEventListener('change', async () => {
    ++revision;
    const previous = document.documentElement.dataset.theme;
    const mode = select.value;
    select.disabled = true;
    try {
      if (bridge) await bridge.set(mode);
      else localStorage.setItem('educoder.appearance.v1', mode);
      apply(mode); select.title = '主题选择会保留，跟随系统时随系统外观变化';
    } catch {
      apply(previous); select.title = '主题暂未保存，原设置保留。可稍后再试。';
    } finally { select.disabled = false; }
  });
})();
