// URL/SSRF guards for the web-search module. The gateway itself listens on
// localhost and the user's LAN is reachable from this process, so any URL the
// LLM asks us to fetch must be vetted before a single byte leaves the box.

const PRIVATE_HOST_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.intranet'];

function isPrivateIpv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => !Number.isFinite(value) || value > 255)) return true;
  const [a, b] = octets;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateIpv6(host) {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized.includes(':')) return false;
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (/^f[cd]/.test(normalized)) return true; // fc00::/7 unique local
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  return false;
}

export function isPrivateHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === 'broadcasthost') return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isPrivateIpv4(host)) return true;
  if (isPrivateIpv6(host)) return true;
  return false;
}

// Returns { ok: true, url: URL } or { ok: false, reason }.
export function validateOutboundUrl(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return { ok: false, reason: 'url is required' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `"${text}" is not a valid absolute URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported scheme "${url.protocol}" (only http/https)` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, reason: `host "${url.hostname}" is private/loopback and cannot be fetched` };
  }
  return { ok: true, url };
}

export default { isPrivateHost, validateOutboundUrl };
