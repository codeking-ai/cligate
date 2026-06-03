// Deterministic, conservative secret redaction for anything we PERSIST or send
// to a model from the memory / skill subsystem (defense-in-depth on top of the
// "never store secrets" prompt rule — design goal G7).
//
// Conservative by intent: it targets high-confidence patterns (known token
// shapes, and "label: value" pairs for explicit secret labels) so it scrubs
// credentials without mangling ordinary prose/steps. It will NOT catch a bare,
// unlabeled password — that is left to the LLM's distillation instruction.

const PLACEHOLDER = '[redacted]';

// Known credential token shapes (high confidence).
const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,            // OpenAI-style
  /\bghp_[A-Za-z0-9]{20,}\b/g,             // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,     // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                 // AWS access key id
  /\bya29\.[A-Za-z0-9._-]{20,}\b/g,        // Google OAuth
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi  // Authorization: Bearer <token>
];

// "label : value" / "label = value" for explicit secret labels (EN + common CN).
const LABELED_SECRET = /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|authorization|auth)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;
const LABELED_SECRET_CN = /(密码|口令|密钥|令牌|私钥)\s*(?:是|为|:|：|=)\s*("[^"]*"|'[^']*'|\S+)/g;

export function redactSecrets(value) {
  if (value == null) return value;
  let text = String(value);
  for (const re of TOKEN_PATTERNS) {
    text = text.replace(re, PLACEHOLDER);
  }
  text = text.replace(LABELED_SECRET, (_m, label) => `${label}: ${PLACEHOLDER}`);
  text = text.replace(LABELED_SECRET_CN, (_m, label) => `${label}：${PLACEHOLDER}`);
  return text;
}

export function redactSecretsList(values) {
  if (!Array.isArray(values)) return values;
  return values.map((v) => redactSecrets(v));
}

export default redactSecrets;
