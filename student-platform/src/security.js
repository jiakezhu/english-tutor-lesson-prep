import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function passwordHash(value) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
export function passwordMatches(value, stored) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(hash, 'hex'));
}
export function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 200;
}

// JSON.parse alone accepts duplicate keys. Reject ambiguous wire data before hashing.
export function strictJSON(source) {
  const parsed = JSON.parse(source);
  const tokens = source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) || [];
  let index = 0;
  function consume(depth = 0) {
    if (depth > 64) throw new Error('JSON nesting limit');
    const next = tokens[index++];
    if (next === '{') {
      const keys = new Set();
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++]);
        if (keys.has(key)) throw new Error('Duplicate JSON key');
        keys.add(key); index++; consume(depth + 1);
        if (tokens[index] === ',') index++;
      }
      index++;
    } else if (next === '[') {
      while (tokens[index] !== ']') {
        consume(depth + 1);
        if (tokens[index] === ',') index++;
      }
      index++;
    }
  }
  consume(); canonicalJSON(parsed);
  return parsed;
}
export function secretMatches(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// RFC 8785: ECMAScript number/string serialization and UTF-16 key ordering.
// I-JSON excludes non-finite numbers and lone UTF-16 surrogates.
export function canonicalJSON(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') {
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = value.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode');
        } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('Invalid Unicode');
      }
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(
    key => `${canonicalJSON(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  throw new Error('Unsupported canonical JSON value');
}
export function publicationHash(publication) {
  const { content_hash: ignored, ...immutable } = publication;
  return `sha256:${digest(canonicalJSON(immutable))}`;
}
