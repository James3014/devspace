/** Redact assembled sensitive material at a neutral infrastructure boundary. */
export function redactSensitiveText(text: string): string {
  const preprocessed = text
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
  return redactSensitiveKeyValues(preprocessed)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

const SENSITIVE_KEY = /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|token|authorization|secret|password|passwd|credential|private[_ -]?key)/i;
const KEY_CHARACTER = /[A-Za-z0-9_.-]/;

function redactSensitiveKeyValues(text: string): string {
  let output = "";
  let copiedThrough = 0;
  let index = 0;
  while (index < text.length) {
    const candidate = readKeyValueCandidate(text, index);
    if (!candidate) {
      if (text[index] && KEY_CHARACTER.test(text[index]!)) {
        // Consume one whole key-like run on failure.  In particular, do not
        // retry every suffix of a long non-key string (which made malformed
        // diagnostics quadratic), while structural delimiters remain visible
        // to the outer scanner for subsequent fields.
        while (
          index < text.length
          && (KEY_CHARACTER.test(text[index]!) || /\s/.test(text[index]!))
        ) index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (!SENSITIVE_KEY.test(candidate.key)) {
      index = candidate.valueStart;
      continue;
    }
    index = candidate.valueEnd;
    output += candidate.quotedKey
      ? text.slice(copiedThrough, candidate.valueStart)
      : text.slice(copiedThrough, candidate.valueStart).replace(/[:=]\s*$/, "=");
    if (candidate.quote) {
      output += `${candidate.quote}[REDACTED]${candidate.closed ? candidate.quote : ""}`;
    } else {
      output += "[REDACTED]";
    }
    copiedThrough = candidate.valueEnd;
  }
  return copiedThrough === 0 ? text : output + text.slice(copiedThrough);
}

interface KeyValueCandidate {
  key: string;
  valueStart: number;
  valueEnd: number;
  quote?: '"' | "'";
  quotedKey?: boolean;
  closed: boolean;
}

function readKeyValueCandidate(text: string, start: number): KeyValueCandidate | undefined {
  const first = text[start];
  let key: string;
  let keyEnd: number;
  if (first === '"' || first === "'") {
    const quote = first;
    let end = start + 1;
    let escaped = false;
    for (; end < text.length; end += 1) {
      const character = text[end];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        break;
      }
    }
    if (end >= text.length || text[end] !== quote) return undefined;
    key = text.slice(start + 1, end);
    keyEnd = end + 1;
  } else if (first && KEY_CHARACTER.test(first)) {
    keyEnd = start + 1;
    while (keyEnd < text.length && (KEY_CHARACTER.test(text[keyEnd]!) || /\s/.test(text[keyEnd]!))) keyEnd += 1;
    key = text.slice(start, keyEnd).trim();
    if (!key) return undefined;
  } else {
    return undefined;
  }

  let delimiter = keyEnd;
  while (delimiter < text.length && /\s/.test(text[delimiter]!)) delimiter += 1;
  if (text[delimiter] !== ":" && text[delimiter] !== "=") return undefined;
  let valueStart = delimiter + 1;
  while (valueStart < text.length && /\s/.test(text[valueStart]!)) valueStart += 1;
  if (valueStart >= text.length) return undefined;

  const quote = text[valueStart] === '"' || text[valueStart] === "'" ? text[valueStart] as '"' | "'" : undefined;
  if (quote) {
    let end = valueStart + 1;
    let escaped = false;
    for (; end < text.length; end += 1) {
      const character = text[end];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        return { key, valueStart, valueEnd: end + 1, quote, quotedKey: first === '"' || first === "'", closed: true };
      }
    }
    return { key, valueStart, valueEnd: text.length, quote, quotedKey: first === '"' || first === "'", closed: false };
  }
  let valueEnd = valueStart;
  while (valueEnd < text.length && !/[\s,;}\]]/.test(text[valueEnd]!)) valueEnd += 1;
  return { key, valueStart, valueEnd, closed: false, quotedKey: first === '"' || first === "'" };
}
