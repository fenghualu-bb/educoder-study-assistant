export function extractCards(nodes) {
  return Array.from(nodes, (node, index) => {
    const title = node.querySelector('[class*="bottomTitle"]')?.textContent?.trim();
    const rawProgress = node.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow');
    const progress = Number(rawProgress);
    if (!title) throw new Error(`video card ${index} has no title`);
    if (rawProgress === null || rawProgress === undefined || !Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw new Error(`video card ${title} has invalid progress`);
    }
    let cardIdentity;
    const image = node.querySelector('[class*="imgWrap"] img')?.getAttribute('src');
    if (image) {
      try {
        const url = new URL(image, 'https://www.educoder.net');
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) cardIdentity = url.origin + url.pathname;
      } catch { /* A missing preview never supplies an identity. */ }
    }
    return { title, progress, index, ...(cardIdentity ? { cardIdentity } : {}) };
  });
}

export function normalizeClassroomUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('请输入有效的头歌课堂链接');
  }
  const match = url.pathname.match(/^\/classrooms\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (url.protocol !== 'https:' || url.hostname !== 'www.educoder.net' || url.port || url.username || url.password || !match) {
    throw new Error('请输入有效的头歌课堂链接');
  }
  return `https://www.educoder.net/classrooms/${match[1]}/video`;
}
