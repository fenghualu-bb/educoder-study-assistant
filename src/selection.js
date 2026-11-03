export function pickNext(cards) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
  for (const card of cards) {
    if (!card || typeof card.title !== 'string' || !card.title.trim()) {
      throw new TypeError('card title is required');
    }
    if (!Number.isFinite(card.progress) || card.progress < 0 || card.progress > 100) {
      throw new RangeError(`invalid progress for ${card.title}`);
    }
  }
  return cards.find(card => card.progress < 100) ?? null;
}

export function advance({ page, hasNext }) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be positive');
  if (typeof hasNext !== 'boolean') throw new TypeError('hasNext must be boolean');
  return hasNext ? page + 1 : null;
}
