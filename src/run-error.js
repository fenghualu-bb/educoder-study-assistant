export const RUN_ERROR_CODES = Object.freeze([
  'STOPPED', 'MEDIA_ERROR', 'MEDIA_STALL', 'MEDIA_TIMEOUT', 'CDN_TIMEOUT',
  'LOGIN_REQUIRED', 'LIST_UNAVAILABLE', 'PAGE_LOAD_FAILED', 'CHECKPOINT',
  'CARD_CHANGED', 'VERIFY_NOT_100', 'SCAN_PARTIAL', 'COURSE_CHANGED',
  'FEATURE_DISABLED', 'JOURNAL_WRITE_FAILED', 'UNKNOWN',
]);

export class RunError extends Error {
  constructor(code, message) {
    if (!RUN_ERROR_CODES.includes(code)) throw new RangeError(`unknown run error code: ${code}`);
    super(message);
    this.name = 'RunError';
    this.code = code;
  }
}

export function classifyRunError(error) {
  if (error instanceof RunError) return error.code;
  return error?.message === 'task stopped' ? 'STOPPED' : 'UNKNOWN';
}
