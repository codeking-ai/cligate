export function normalizeDesktopError(error) {
  return {
    message: String(error?.message || error || 'desktop tool failed'),
    code: String(error?.code || ''),
    status: Number.isFinite(error?.status) ? error.status : null
  };
}

export default {
  normalizeDesktopError
};
