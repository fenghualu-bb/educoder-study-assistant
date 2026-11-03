export function layoutFromInventory(snapshot) {
  if (!snapshot?.complete || !Array.isArray(snapshot.items)) throw new Error('SCAN_PARTIAL');
  if (snapshot.items.some(item => !Number.isFinite(item?.progress) || item.progress < 0 || item.progress > 100)) {
    throw new Error('SCAN_PARTIAL');
  }
  const layout = snapshot.items.map(({ page, index, title }) => ({ page, index, title }));
  for (const item of layout) {
    if (!Number.isInteger(item.page) || item.page < 1 || !Number.isInteger(item.index)
      || item.index < 0 || typeof item.title !== 'string' || !item.title) throw new Error('COURSE_CHANGED');
  }
  layout.sort((a, b) => a.page - b.page || a.index - b.index);
  if (layout.some((item, i) => i > 0 && item.page === layout[i - 1].page && item.index === layout[i - 1].index)) {
    throw new Error('COURSE_CHANGED');
  }
  return layout;
}

export function compareLayout(savedLayout, freshSnapshot) {
  if (!freshSnapshot?.complete) return { ok: false, code: 'SCAN_PARTIAL' };
  try {
    const fresh = layoutFromInventory(freshSnapshot);
    if (JSON.stringify(savedLayout) !== JSON.stringify(fresh)) return { ok: false, code: 'COURSE_CHANGED' };
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.message === 'SCAN_PARTIAL' ? 'SCAN_PARTIAL' : 'COURSE_CHANGED' };
  }
}
