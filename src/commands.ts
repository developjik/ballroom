/**
 * Command canonicalisation for one-time approvals.
 *
 * The problem this solves: a hook that only accepts an exact `action_hash`
 * forces another owner approval whenever the model re-emits the same command
 * with flags in a different order (`git push origin main --force` vs.
 * `git push --force origin main`). The agent then burns a turn, the owner gets
 * a second prompt for the very same action, and the loop the gate was meant to
 * stop is replaced by an approval loop.
 *
 * So a grant can be issued for a *normalised* command instead of a hash:
 *
 *   - whitespace is collapsed, quotes are removed, tokens that contain spaces
 *     are re-quoted;
 *   - the program name is lower-cased, arguments keep their case;
 *   - within each simple command (split on `&&`, `||`, `;`, `|`, newlines) the
 *     subcommand stays first, flags are lifted in front of the remaining
 *     positional arguments and sorted, so flag order stops mattering;
 *   - nothing else is rewritten: an added/removed/changed argument produces a
 *     different normal form and needs a new approval.
 *
 * Limits (documented in docs/SPEC.md §6.5): this is a convenience for the
 * repeat-prompt problem, not a security boundary. Two different commands can
 * canonicalise to the same string (`git -C a status` reads `a` as a positional),
 * and only the sandbox is trusted to stop the action itself.
 */

const OPERATORS = new Set(['&&', '||', ';', '|', '&']);

export function tokenizeCommand(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let hasContent = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      hasContent = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      hasContent = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

function quoteToken(token: string): string {
  if (token === '') return '""';
  if (/^[A-Za-z0-9_@%+=:,./^-]+$/.test(token)) return token;
  return `"${token.replace(/(["\\$`])/g, '\\$1')}"`;
}

function normalizeSegment(tokens: string[]): string {
  if (tokens.length === 0) return '';
  const [program, ...rest] = tokens as [string, ...string[]];
  // A bare second token is a subcommand (`git push`, `npm publish`) and stays
  // in front of the flags; otherwise `git push --force` would read as
  // `git --force push`.
  let subcommand: string | null = null;
  if (rest.length > 0 && !rest[0]!.startsWith('-')) {
    subcommand = rest.shift()!;
  }
  const flags: string[] = [];
  const args: string[] = [];
  for (const token of rest) {
    if (token.startsWith('-') && token !== '-') flags.push(token);
    else args.push(token);
  }
  flags.sort();
  const head = program.toLowerCase();
  return [head, ...(subcommand ? [subcommand] : []), ...flags, ...args].map(quoteToken).join(' ');
}

export function normalizeCommand(raw: string): string {
  const tokens = tokenizeCommand(raw);
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (OPERATORS.has(token)) {
      segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  segments.push(current);
  return segments
    .map((segment) => normalizeSegment(segment))
    .filter((segment) => segment !== '')
    .join(' ; ');
}

/**
 * `3회 반복` breaker: the tuple a loop repeats on.
 * Two agents can say the same sentence to each other forever; the signature
 * only collides when sender, recipient, content and task all match.
 */
export function loopSignature(input: {
  sender: string;
  recipient: string | null;
  content: string;
  taskId: string | null;
}): string {
  // Not a security hash; a stable key. Uses a cheap FNV-1a so the value fits in
  // an event payload and stays readable in the log.
  const material = [input.sender, input.recipient ?? '-', input.taskId ?? '-', input.content]
    .join('\u0000');
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Mentions are parsed server-side (`@agent_id`), never by the model. */
export function parseMentions(content: string, known: string[]): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(/(^|[\s(,.;:!?])@([A-Za-z0-9._-]{2,64})/g)) {
    const handle = match[2];
    if (handle && known.includes(handle)) found.add(handle);
  }
  return [...found];
}
