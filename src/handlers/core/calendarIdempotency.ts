/**
 * Deterministic calendar event IDs and the 409 branch — TypeScript half.
 *
 * Spec: `claudia-write-path-spec.md` D1 (Phase 1).
 *
 * A deliberate PORT of `phase-shared/calendar_envelope/idempotency.py`. This is
 * the side that matters most: the school-document ingest runs through this MCP,
 * and the 20 Aug duplicates came from here.
 *
 * WHY THE PORT MUST BE EXACT. If this slugs a title even slightly differently
 * from the Python side, the two derive DIFFERENT ids for the same event, both
 * inserts succeed, and the duplicate returns — with no error anywhere to notice
 * it by. `gate-vectors.json` pins the derivation literally for exactly that
 * reason, and both test suites assert against it.
 *
 * CAUTION 4. The derivation is versioned (`key_v1`) and frozen: changing it
 * orphans every event the pipeline has written. A change is a migration with an
 * explicit old->new mapping pass, never an edit in place.
 *
 * CANONICAL SOURCE: Claudia repo, phase-shared/calendar_envelope/calendarIdempotency.ts
 * Deployed to:      google-calendar-mcp-fork/src/handlers/core/calendarIdempotency.ts
 */
import { createHash } from 'crypto';
import { calendar_v3 } from 'googleapis';

export const KEY_VERSION = 'key_v1';
export const ID_PREFIX = 'kb';

const VALID_ID_RE = /^[a-v0-9]{5,1024}$/;

/**
 * Reduce a title to what survives a re-parse.
 *
 * ORDER IS LOAD-BEARING. Normalise to NFKD, strip combining marks so accents
 * fold to their base letter, and only THEN substitute on the still-Unicode
 * string — so a dash of any width becomes a separator rather than vanishing.
 * Folding to ASCII first DROPS non-ASCII punctuation, which slugs "Grade 6-9"
 * to `grade-6-9` but "Grade 6–9" to `grade-69`: two keys for one event, from
 * exactly the drift this function exists to absorb.
 */
export function titleSlug(title: string | null | undefined): string {
    const decomposed = (title ?? '').normalize('NFKD');
    // \p{M} is the Unicode combining-mark category — the accents NFKD split off.
    const withoutMarks = decomposed.replace(/\p{M}/gu, '');
    return withoutMarks.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build the `key_v1` natural key. FROZEN — see caution 4.
 *
 * Shape: `{source}|{section}|{date}|{title_slug}`
 *
 * Only fields STABLE across re-parses go in. Times, descriptions and venues stay
 * out on purpose and live in the content hash instead: a document that moves an
 * event from 08:00 to 08:30 between revisions is the same event and must
 * converge onto the same row rather than mint a second.
 */
export function naturalKey(opts: {
    source: string; date: string; title: string; section?: string | null;
}): string {
    return `${opts.source}|${opts.section ?? ''}|${opts.date}|${titleSlug(opts.title)}`;
}

/** base32hex: lowercase a-v and 0-9, which is Calendar's alphabet for a
 *  client-supplied id. Node has no built-in, so it is spelled out. */
const B32HEX = '0123456789abcdefghijklmnopqrstuv';

function base32hex(bytes: Buffer): string {
    let bits = 0, value = 0, out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32HEX[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32HEX[(value << (5 - bits)) & 31];
    return out;
}

export function eventIdFor(key: string): string {
    const digest = createHash('sha256').update(key, 'utf8').digest();
    const candidate = ID_PREFIX + base32hex(digest).slice(0, 30);
    if (!VALID_ID_RE.test(candidate)) {
        throw new Error(`derived id ${candidate} is not valid base32hex`);
    }
    return candidate;
}

export function isDerivedId(eventId: string | null | undefined): boolean {
    return !!eventId && eventId.startsWith(ID_PREFIX) && VALID_ID_RE.test(eventId);
}

/** Fields a re-parse might legitimately change. */
export const CONTENT_FIELDS = ['summary', 'description', 'location', 'start', 'end'] as const;

/**
 * Hash of the parts of a payload a re-parse might change.
 *
 * EXCLUDES extendedProperties deliberately: the envelope carries a run id and a
 * timestamp, so hashing it would make every re-ingest look like a content
 * change and turn every no-op into a patch. The hash answers one question —
 * did the source document change? — and run metadata is not the document.
 *
 * Key order must match Python's `json.dumps(sort_keys=True)`, so keys are
 * sorted and separators carry no spaces.
 */
export function contentHash(body: calendar_v3.Schema$Event): string {
    const material: Record<string, unknown> = {};
    for (const f of CONTENT_FIELDS) material[f] = (body as any)[f] ?? null;
    return 'sha256:' + createHash('sha256')
        .update(stableStringify(material), 'utf8').digest('hex');
}

/** JSON with sorted keys and no padding — byte-identical to Python's
 *  `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map((k) =>
        JSON.stringify(k) + ':' + stableStringify((value as any)[k])).join(',') + '}';
}

/**
 * Sources too generic to key on. `calendar-mcp` and `control_centre` are what
 * the envelope stamps when nobody said anything more specific, so keying on
 * them would put every unattributed write from every path into one namespace,
 * where two unrelated events sharing a title and a date would silently converge
 * onto one row. Idempotency is opt-in by naming your source.
 */
const GENERIC_SOURCES = new Set(['calendar-mcp', 'control_centre']);

/**
 * Will this write get a derived id? Asked in two places, so it lives in one.
 *
 * The second caller is the duplicate-similarity check: when the id is derived,
 * the API enforces uniqueness EXACTLY and the 409 branch decides what to do
 * about it, so a fuzzy 95%-similar guess is both redundant and harmful — it
 * fires before the branch can run and blocks a legitimate convergence patch
 * when a source document changes slightly.
 */
export function isIdempotentWrite(
    extendedProperties: calendar_v3.Schema$Event['extendedProperties'] | null | undefined,
    explicitId?: string | null,
): boolean {
    if (explicitId) return false;          // the caller's own id wins
    const priv = (extendedProperties?.private ?? {}) as Record<string, string>;
    const source = (priv.claudia_source ?? '').trim();
    return !!source && !GENERIC_SOURCES.has(source);
}

/**
 * Derive a natural key and id from a built request body, or null.
 *
 * Returns null — leaving the id server-assigned, i.e. the old behaviour — when:
 *   - the caller supplied an explicit eventId (their choice wins), or
 *   - the body names no `claudia_source`, or names only the generic default.
 *
 * That last exclusion is deliberate. `calendar-mcp` is what the envelope stamps
 * when nobody said anything more specific, so keying on it would put every
 * unattributed write from every path into one namespace, where two unrelated
 * events sharing a title and a date would silently converge onto one row.
 * Idempotency is opt-in by naming your source.
 */
export function deriveIdFromBody(
    body: calendar_v3.Schema$Event, explicitId?: string | null,
): { naturalKey: string; eventId: string; keyVersion: string } | null {
    if (!isIdempotentWrite(body.extendedProperties, explicitId)) return null;

    const priv = (body.extendedProperties?.private ?? {}) as Record<string, string>;
    const source = (priv.claudia_source ?? '').trim();

    const date = body.start?.date ?? (body.start?.dateTime ?? '').slice(0, 10);
    const title = body.summary ?? '';
    if (!date || !title) return null;

    const key = naturalKey({ source, date, title, section: priv.claudia_section ?? null });
    return { naturalKey: key, eventId: eventIdFor(key), keyVersion: KEY_VERSION };
}

export const ACTION_CREATED = 'created';
export const ACTION_NOOP = 'noop';
export const ACTION_PATCH = 'patch';
export const ACTION_SUPPRESSED = 'suppressed';

/**
 * What to do when insert returns 409 and the existing row has been fetched.
 *
 *   status cancelled          -> suppress. NEVER resurrect.
 *   confirmed, hash matches   -> no-op  (a retry whose first write landed)
 *   confirmed, hash differs   -> patch  (the source document changed)
 *
 * The cancelled branch is not a corner case: five Claudia-written events were
 * deliberately deleted, and a handler that revived on 409 brings them all back
 * on the next ingest.
 */
/**
 * A row already carrying this natural key, under an id that is NOT the derived
 * one. Patch THAT row; do not insert. The only way to converge onto a
 * pre-Phase-1 event, because a Calendar event id is fixed at insert.
 */
export const ACTION_ADOPT = 'adopt';

/** Two or more live rows claim the same natural key. Write nothing, say so. */
export const ACTION_AMBIGUOUS = 'ambiguous';

/**
 * What to do when a natural-key lookup runs BEFORE the insert (task 1.12).
 *
 * Port of `idempotency.decide_on_key_match`. Returns the action and, when there
 * is one to act on, the id of the row to patch.
 *
 *   no match                        -> created     insert as normal
 *   one match, id === derived        -> created     same row; the 409 branch owns it
 *   one match, other id, cancelled   -> suppressed
 *   one match, other id, same hash   -> noop
 *   one match, other id, changed     -> adopt
 *   two or more matches              -> ambiguous
 *
 * WHY THIS EXISTS (tracker C23). Convergence is by derived id, and a Calendar
 * event id is fixed at insert and cannot be changed — so every row written
 * before Phase 1 has a server-assigned id it can never trade for a derived one.
 * A re-ingest computes an id that does not exist, the insert returns 201, the
 * 409 branch never fires, and the calendar ends with two copies of every row:
 * the exact defect D1 prevents, arriving through the one door D1 does not
 * cover. `claudia_natural_key` is queryable server-side, so the key finds the
 * row the id cannot.
 *
 * WHY THIS IS NOT THE "read before write" THE SPEC REJECTED. D1 rightly
 * dismisses searching before writing as duplicate PREVENTION: a read narrows
 * the race window without closing it. Nothing here changes that. The derived id
 * and the 409 branch remain the sole authority on races; this is an ADOPTION
 * path for rows that predate the scheme, and if it races and loses, the insert
 * still lands on the derived id and the 409 branch still decides.
 *
 * WHY AMBIGUOUS REFUSES. `key_v1` excludes times on purpose, so two distinct
 * events sharing source, section, date and title slug collapse onto one key.
 * Patching one would be a silent merge — the other stops existing as its own
 * row and nothing reports it. A refusal a human can read beats that.
 *
 * WHY CANCELLED IS SUPPRESSED. Without this branch 1.12 would REINTRODUCE the
 * resurrection bug: the 409 branch protects a deleted row only at its derived
 * id, and an adoption path ignoring status would insert a fresh copy under a new
 * id for a key whose row a human deleted. The narrow reading is deliberate —
 * distinguishing a reconciliation cancel and reviving it is task 3.1d, which
 * must land on both sides at once (the Python half already has ACTION_REVIVE;
 * this one does not, and that asymmetry is 3.1d, not an oversight here).
 *
 * Recurring INSTANCES are ignored (invariant 5): an occurrence is not the row
 * carrying the key, and patching one desynchronises the series.
 */
export function decideOnKeyMatch(
    matches: calendar_v3.Schema$Event[] | null | undefined,
    desiredHash: string,
    derivedId: string,
): { action: string; targetId: string | null } {
    const rows = (matches ?? []).filter((r) => !r?.recurringEventId);
    if (rows.length === 0) return { action: ACTION_CREATED, targetId: null };
    if (rows.length > 1) return { action: ACTION_AMBIGUOUS, targetId: null };

    const row = rows[0];
    const rowId = row.id ?? null;
    // Already the derived id: let the insert run and the 409 branch decide, so
    // that case has exactly one code path rather than two that can drift.
    if (rowId === derivedId) return { action: ACTION_CREATED, targetId: null };
    if (row.status === 'cancelled') return { action: ACTION_SUPPRESSED, targetId: null };
    const found = (row.extendedProperties?.private as Record<string, string> | undefined)
        ?.claudia_content_hash;
    return { action: found === desiredHash ? ACTION_NOOP : ACTION_ADOPT, targetId: rowId };
}

export function decideOnConflict(
    existing: calendar_v3.Schema$Event | null | undefined, desiredHash: string,
): string {
    // 409 with nothing readable behind it: the id is taken so creating is
    // impossible, and patching an event we cannot read is worse than nothing.
    if (!existing) return ACTION_SUPPRESSED;
    if (existing.status === 'cancelled') return ACTION_SUPPRESSED;
    const found = (existing.extendedProperties?.private as Record<string, string> | undefined)
        ?.claudia_content_hash;
    return found === desiredHash ? ACTION_NOOP : ACTION_PATCH;
}
