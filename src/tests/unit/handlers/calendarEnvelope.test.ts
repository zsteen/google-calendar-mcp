/**
 * The TypeScript gate conforms to the shared vectors.
 *
 * `gate-vectors.json` is the contract between this gate and the Python one in
 * `phase-shared/calendar_envelope/envelope.py`. Claudia writes to one calendar
 * through both, so if they disagree an event reaches the calendar through
 * whichever is laxer. The Python suite loads this same file and asserts the
 * same outcomes; change one implementation without the other and one of the two
 * suites goes red.
 *
 * CANONICAL SOURCE: Claudia repo, phase-shared/calendar_envelope/calendarEnvelope.test.ts
 * Deployed to:      google-calendar-mcp-fork/src/tests/unit/handlers/calendarEnvelope.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    GATE_VECTORS_VERSION,
    PayloadValidationError,
    applyWriteEnvelope,
    ensureEnvelope,
    normalizeDescription,
    normalizeSingleLine,
    validateCreatePayload,
    validatePayload,
} from '../../../handlers/core/calendarEnvelope.js';
import {
    ACTION_ADOPT,
    ACTION_AMBIGUOUS,
    ACTION_CREATED,
    ACTION_NOOP,
    ACTION_PATCH,
    ACTION_REVIVE,
    ACTION_SUPPRESSED,
    contentHash,
    decideOnConflict,
    decideOnKeyMatch,
    eventIdFor,
    isDerivedId,
    isIdempotentWrite,
    naturalKey,
    titleSlug,
} from '../../../handlers/core/calendarIdempotency.js';
import {
    reconciledKeys,
    recordRevive,
} from '../../../handlers/core/calendarReconciliation.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
    readFileSync(join(here, '../../../handlers/core/gate-vectors.json'), 'utf-8'),
);

describe('shared gate vectors', () => {
    it('vectors version matches the implementation', () => {
        // The drift tripwire: changing the vectors means bumping `version`
        // there and GATE_VECTORS_VERSION in BOTH implementations.
        expect(vectors.version).toBe(GATE_VECTORS_VERSION);
    });

    for (const c of vectors.validate as Array<any>) {
        it(`validate: ${c.name}`, () => {
            if (c.accept) {
                expect(() => validatePayload(structuredClone(c.body))).not.toThrow();
                return;
            }
            let caught: unknown = null;
            try {
                validatePayload(structuredClone(c.body));
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(PayloadValidationError);
            if (c.expect) {
                const joined = (caught as PayloadValidationError).problems.join(' | ');
                expect(joined).toContain(c.expect);
            }
        });
    }

    for (const c of vectors.validate_create as Array<any>) {
        it(`validateCreate: ${c.name}`, () => {
            if (c.accept) {
                expect(() => validateCreatePayload(structuredClone(c.body))).not.toThrow();
                // The create rule ADDS to validatePayload; it never replaces it.
                expect(() => validatePayload(structuredClone(c.body))).not.toThrow();
                return;
            }
            let caught: unknown = null;
            try {
                validateCreatePayload(structuredClone(c.body));
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(PayloadValidationError);
            if (c.expect) {
                const joined = (caught as PayloadValidationError).problems.join(' | ');
                expect(joined).toContain(c.expect);
            }
        });
    }

    for (const c of vectors.normalize_description as Array<any>) {
        it(`normalizeDescription: ${c.name}`, () => {
            expect(normalizeDescription(c.in)).toBe(c.out);
        });
    }

    for (const c of vectors.normalize_single_line as Array<any>) {
        it(`normalizeSingleLine: ${c.name}`, () => {
            expect(normalizeSingleLine(c.in)).toBe(c.out);
        });
    }
});

describe('D1 - the derivation both languages must agree on exactly', () => {
    // A mismatch here is silent and expensive: different ids for the same event
    // means both inserts succeed and the duplicate returns with no error.
    for (const c of vectors.title_slug as Array<any>) {
        it(`titleSlug: ${JSON.stringify(c.in)}`, () => {
            expect(titleSlug(c.in)).toBe(c.out);
        });
    }

    for (const c of vectors.natural_key as Array<any>) {
        it(`naturalKey + id: ${c.key.slice(0, 44)}`, () => {
            const key = naturalKey({
                source: c.source, date: c.date, title: c.title, section: c.section,
            });
            expect(key).toBe(c.key);
            expect(eventIdFor(key)).toBe(c.event_id);
        });
    }

    for (const [i, c] of (vectors.content_hash as Array<any>).entries()) {
        it(`contentHash #${i}`, () => {
            expect(contentHash(c.body)).toBe(c.hash);
        });
    }

    it('excludes the envelope from the content hash', () => {
        // Otherwise a run id makes every re-ingest look like a content change
        // and turns every no-op into a patch.
        const base: any = { summary: 'x', start: { date: '2026-10-01' } };
        const a = contentHash({ ...base, extendedProperties: { private: { claudia_run_id: 'r1' } } });
        const b = contentHash({ ...base, extendedProperties: { private: { claudia_run_id: 'r2' } } });
        expect(a).toBe(b);
    });

    it('derived ids are Calendar-legal', () => {
        const id = eventIdFor('anything');
        expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
        expect(id.length).toBe(32);
        expect(isDerivedId(id)).toBe(true);
        expect(isDerivedId('e17r4t1m6d62ov32jh3plrstmg')).toBe(false);
    });
});

describe('isIdempotentWrite - which writes get a derived id', () => {
    const ext = (source?: string) =>
        (source ? { private: { claudia_source: source } } : {}) as any;

    it('a named source opts in', () => {
        expect(isIdempotentWrite(ext('term-doc:redhill-2026-t3'))).toBe(true);
    });

    it('no source stays server-assigned', () => {
        expect(isIdempotentWrite(ext())).toBe(false);
        expect(isIdempotentWrite(undefined)).toBe(false);
    });

    it('the generic defaults do NOT opt in', () => {
        // Keying on them would put every unattributed write into one namespace,
        // where two unrelated events sharing a title and a date would silently
        // converge onto one row.
        expect(isIdempotentWrite(ext('calendar-mcp'))).toBe(false);
        expect(isIdempotentWrite(ext('control_centre'))).toBe(false);
    });

    it("an explicit caller id wins over derivation", () => {
        expect(isIdempotentWrite(ext('term-doc:x'), 'my-own-id')).toBe(false);
    });
});

describe('the 409 branch', () => {
    const withHash = (h: string | null, status = 'confirmed') => ({
        status, extendedProperties: { private: h ? { claudia_content_hash: h } : {} },
    } as any);

    it('a retry whose first write landed is a no-op', () => {
        expect(decideOnConflict(withHash('sha256:a'), 'sha256:a')).toBe(ACTION_NOOP);
    });

    it('a changed source document converges', () => {
        expect(decideOnConflict(withHash('sha256:old'), 'sha256:new')).toBe(ACTION_PATCH);
    });

    it('a cancelled event is NEVER resurrected', () => {
        expect(decideOnConflict(withHash('sha256:a', 'cancelled'), 'sha256:a'))
            .toBe(ACTION_SUPPRESSED);
    });

    it('an unreadable existing event suppresses rather than guessing', () => {
        expect(decideOnConflict(null, 'sha256:a')).toBe(ACTION_SUPPRESSED);
    });

    it('a pre-Phase-1 event with no stored hash converges', () => {
        expect(decideOnConflict(withHash(null), 'sha256:a')).toBe(ACTION_PATCH);
    });
});

describe('1.12 - the adoption path for rows written before the id scheme', () => {
    // Mirrors phase-shared/tests/test_key_adoption.py. The two halves must agree:
    // this side is the one the school-document ingest runs through, and a
    // disagreement means a row adopted by one language and duplicated by the
    // other, with no error anywhere to notice it by.
    const HASH = 'sha256:abc123';
    const DERIVED = 'kb4u63oo5a3k0rj5l13r1q074u24ipiu';
    const LEGACY = '7p2q9x0mnbvc1234567890asdf';

    const row = (id: string, opts: { status?: string; hash?: string | null;
                                     recurringEventId?: string } = {}) => ({
        id,
        status: opts.status ?? 'confirmed',
        ...(opts.recurringEventId ? { recurringEventId: opts.recurringEventId } : {}),
        extendedProperties: {
            private: {
                claudia_natural_key: 'term-doc:redhill-2026-t3||2026-10-01|team-photos',
                ...(opts.hash === null ? {} : { claudia_content_hash: opts.hash ?? HASH }),
            },
        },
    } as any);

    it('adopts a pre-Phase-1 row rather than duplicating it', () => {
        expect(decideOnKeyMatch([row(LEGACY, { hash: 'sha256:old' })], HASH, DERIVED))
            .toEqual({ action: ACTION_ADOPT, targetId: LEGACY });
    });

    it('an unchanged row is a no-op, not a patch', () => {
        expect(decideOnKeyMatch([row(LEGACY)], HASH, DERIVED))
            .toEqual({ action: ACTION_NOOP, targetId: LEGACY });
    });

    it('no match falls through to a normal insert', () => {
        expect(decideOnKeyMatch([], HASH, DERIVED))
            .toEqual({ action: ACTION_CREATED, targetId: null });
        expect(decideOnKeyMatch(null, HASH, DERIVED))
            .toEqual({ action: ACTION_CREATED, targetId: null });
    });

    it('a row already at the derived id is left to the 409 branch', () => {
        expect(decideOnKeyMatch([row(DERIVED, { hash: 'sha256:old' })], HASH, DERIVED))
            .toEqual({ action: ACTION_CREATED, targetId: null });
    });

    it('a deliberately deleted row is not resurrected under a new id', () => {
        // Without this, 1.12 reintroduces the bug the 409 cancelled branch
        // exists to stop: that branch guards the DERIVED id only.
        expect(decideOnKeyMatch([row(LEGACY, { status: 'cancelled' })], HASH, DERIVED))
            .toEqual({ action: ACTION_SUPPRESSED, targetId: null });
    });

    it('two rows claiming one key refuse rather than merge', () => {
        expect(decideOnKeyMatch([row(LEGACY), row('other7654321zxcv')], HASH, DERIVED))
            .toEqual({ action: ACTION_AMBIGUOUS, targetId: null });
    });

    it('recurring instances are not adoption targets', () => {
        expect(decideOnKeyMatch([row('inst1', { recurringEventId: 'master1' })],
                                HASH, DERIVED))
            .toEqual({ action: ACTION_CREATED, targetId: null });
    });

    it('an instance alongside its master does not read as ambiguous', () => {
        expect(decideOnKeyMatch(
            [row(LEGACY, { hash: 'sha256:old' }), row('inst1', { recurringEventId: LEGACY })],
            HASH, DERIVED)).toEqual({ action: ACTION_ADOPT, targetId: LEGACY });
    });

    it('a row with no hash is adopted, not treated as unchanged', () => {
        expect(decideOnKeyMatch([row(LEGACY, { hash: null })], HASH, DERIVED))
            .toEqual({ action: ACTION_ADOPT, targetId: LEGACY });
    });
});

describe('3.1d - reviving what the PIPELINE cancelled, not what a user deleted', () => {
    // Mirrors phase-shared/tests/test_key_adoption.py and test_reconciliation.py.
    // On the calendar a user deletion and a reconciliation cancel are the SAME
    // `cancelled` row and mean opposite things; only the ledger separates them.
    const HASH = 'sha256:abc123';
    const DERIVED = 'kb4u63oo5a3k0rj5l13r1q074u24ipiu';
    const LEGACY = '7p2q9x0mnbvc1234567890asdf';
    const KEY = 'term-doc:redhill-2026-t3||2026-10-01|team-photos';

    const cancelled = (id: string) => ({
        id, status: 'cancelled',
        extendedProperties: { private: { claudia_natural_key: KEY } },
    } as any);

    // ── the 409 branch ──
    it('revives a cancelled derived id the ledger claims', () => {
        expect(decideOnConflict(cancelled(DERIVED), HASH,
                                { naturalKey: KEY, reconciledKeys: new Set([KEY]) }))
            .toBe(ACTION_REVIVE);
    });

    it('suppresses when the ledger does not claim the key', () => {
        expect(decideOnConflict(cancelled(DERIVED), HASH,
                                { naturalKey: KEY, reconciledKeys: new Set(['other|key']) }))
            .toBe(ACTION_SUPPRESSED);
    });

    it('suppresses when no ledger is supplied at all', () => {
        // The safe default, and what kept this additive: every existing caller
        // behaves exactly as it did.
        expect(decideOnConflict(cancelled(DERIVED), HASH)).toBe(ACTION_SUPPRESSED);
        expect(decideOnConflict(cancelled(DERIVED), HASH, {})).toBe(ACTION_SUPPRESSED);
    });

    it('an empty ledger set suppresses - the normal state today', () => {
        expect(decideOnConflict(cancelled(DERIVED), HASH,
                                { naturalKey: KEY, reconciledKeys: new Set() }))
            .toBe(ACTION_SUPPRESSED);
    });

    it('a CONFIRMED row is never routed to revive', () => {
        const live = { id: DERIVED, status: 'confirmed',
                       extendedProperties: { private: { claudia_content_hash: HASH } } } as any;
        expect(decideOnConflict(live, HASH,
                                { naturalKey: KEY, reconciledKeys: new Set([KEY]) }))
            .toBe(ACTION_NOOP);
    });

    // ── the 1.12 adoption branch ──
    it('revives a cancelled row found by KEY under a non-derived id', () => {
        expect(decideOnKeyMatch([cancelled(LEGACY)], HASH, DERIVED,
                                { naturalKey: KEY, reconciledKeys: new Set([KEY]) }))
            .toEqual({ action: ACTION_REVIVE, targetId: LEGACY });
    });

    it('the adoption branch also suppresses without ledger evidence', () => {
        expect(decideOnKeyMatch([cancelled(LEGACY)], HASH, DERIVED,
                                { naturalKey: KEY, reconciledKeys: new Set(['other']) }))
            .toEqual({ action: ACTION_SUPPRESSED, targetId: null });
        expect(decideOnKeyMatch([cancelled(LEGACY)], HASH, DERIVED))
            .toEqual({ action: ACTION_SUPPRESSED, targetId: null });
    });
});

describe('3.1d - the ledger reader, ported semantics', () => {
    // The replay rule is the contract: append-only, LAST action per key wins.
    // If this drifts from the Python reader the two languages disagree about
    // which events may come back.
    const tmp = join(tmpdir(), `recon-test-${process.pid}-${Math.random()}.jsonl`);
    const write = (lines: string[]) => writeFileSync(tmp, lines.join('\n') + '\n', 'utf-8');
    const rec = (key: string, action: string) =>
        JSON.stringify({ at: '2026-09-15T10:00:00Z', action, natural_key: key,
                         source: 's', event_id: 'e' });

    afterEach(() => { try { unlinkSync(tmp); } catch { /* not created */ } });

    it('a missing file is the normal state, not an error', () => {
        expect(reconciledKeys(join(tmpdir(), 'definitely-absent-ledger.jsonl')))
            .toEqual(new Set());
    });

    it('a cancel puts the key in the set', () => {
        write([rec('a', 'cancelled')]);
        expect(reconciledKeys(tmp)).toEqual(new Set(['a']));
    });

    it('a later revive clears it - last action wins', () => {
        write([rec('a', 'cancelled'), rec('b', 'cancelled'), rec('a', 'revived')]);
        expect(reconciledKeys(tmp)).toEqual(new Set(['b']));
    });

    it('a re-cancel after a revive puts it back', () => {
        write([rec('a', 'cancelled'), rec('a', 'revived'), rec('a', 'cancelled')]);
        expect(reconciledKeys(tmp)).toEqual(new Set(['a']));
    });

    it('a record with no action counts as a cancel, as in Python', () => {
        write([JSON.stringify({ natural_key: 'a' })]);
        expect(reconciledKeys(tmp)).toEqual(new Set(['a']));
    });

    it('one corrupt line does not disable the whole ledger', () => {
        // Because that would silently turn every document-drop into a permanent
        // suppression - the exact failure the ledger exists to prevent.
        write([rec('a', 'cancelled'), '{not json', '', rec('b', 'cancelled')]);
        expect(reconciledKeys(tmp)).toEqual(new Set(['a', 'b']));
    });

    it('a record with no natural_key is skipped', () => {
        write([JSON.stringify({ action: 'cancelled', source: 's' }), rec('a', 'cancelled')]);
        expect(reconciledKeys(tmp)).toEqual(new Set(['a']));
    });

    it('recordRevive appends a record the reader then honours', () => {
        write([rec('a', 'cancelled')]);
        expect(reconciledKeys(tmp)).toEqual(new Set(['a']));
        expect(recordRevive({ naturalKey: 'a', source: 's', eventId: 'e' }, tmp)).toBe(true);
        expect(reconciledKeys(tmp)).toEqual(new Set());
    });

    it('recordRevive creates the ledger directory if it does not exist', () => {
        // The first ever revive may precede the first ever cancel on a fresh
        // box, so the parent directory is not guaranteed to be there.
        const nested = join(tmpdir(), `recon-nested-${process.pid}-${Math.random()}`,
                            'state', 'ledger.jsonl');
        expect(recordRevive({ naturalKey: 'a', source: 's', eventId: 'e' }, nested))
            .toBe(true);
        expect(reconciledKeys(nested)).toEqual(new Set());   // a revive alone sets nothing
        unlinkSync(nested);
    });
});

describe('1.9b - the create-source switch, in BOTH positions', () => {
    // RECONSTRUCTED 2026-09-15, and the reason is the lesson.
    //
    // Six fork-only tests covering this switch were DESTROYED: this file exists
    // in both the repo and the fork, the two copies had diverged, the fork's was
    // UNTRACKED in the fork's own git, and it was overwritten by scp'ing the
    // repo's older copy over it without diffing first. The file map warns in as
    // many words that these duplicated files "have diverged before - diff before
    // you scp"; the two SOURCE files were diffed and the TEST file was not.
    //
    // These are reconstructed from the switch's actual behaviour, not recovered,
    // so they may not match what was lost assertion for assertion. They do
    // restore the property that mattered: a switch tested in only one position
    // is a switch nobody has tested, and for a while today the switch had no
    // test in either position.
    const sourced = (source?: string): any => ({
        summary: 'Sport & Cultural Team Photos',
        start: { date: '2026-10-01' }, end: { date: '2026-10-02' },
        extendedProperties: { private: source ? { claudia_source: source } : {} },
    });

    it('ON + a real source: allowed', () => {
        const body = sourced('term-doc:redhill-2026-t3');
        expect(() => applyWriteEnvelope(body, undefined, { isCreate: true })).not.toThrow();
    });

    it('ON + no source: REFUSED as the GENERIC DEFAULT, not as missing', () => {
        // Worth pinning precisely, because the wording surprised me and the
        // reason is C26 itself. `applyWriteEnvelope` runs ensureEnvelope BEFORE
        // the gate, and ensureEnvelope stamps `calendar-mcp` when the caller
        // said nothing — so a sourceless create never reaches the gate as
        // "missing"; it arrives as the generic default. That substitution is
        // exactly how 22 events came to be written unattributed while every
        // one of them carried a non-empty claudia_source, and it is why
        // counting the field as present proved nothing.
        expect(() => applyWriteEnvelope(sourced(), undefined, { isCreate: true }))
            .toThrow(/generic default/);
        // Absent-as-absent still has its own message, for a caller that reaches
        // the gate directly without the envelope step.
        expect(() => validateCreatePayload(
            { ...sourced(), extendedProperties: { private: {
                claudia_schema: '2', claudia_loc_policy: 'unclassified',
                claudia_loc_confidence: 'n/a' } } } as any))
            .toThrow(/claudia_source is missing/);
    });

    it('ON + the generic default: REFUSED', () => {
        // The exact shape of C26: 22 events written with the default, hence no
        // derived ids and no idempotency at all.
        expect(() => applyWriteEnvelope(sourced('calendar-mcp'), undefined, { isCreate: true }))
            .toThrow(/generic default/);
        expect(() => applyWriteEnvelope(sourced('control_centre'), undefined, { isCreate: true }))
            .toThrow(/generic default/);
    });

    it('OFF + no source: allowed, so deploying the build is a no-op', () => {
        // The property that made the 1.9b deploy safe to reason about: until
        // someone sets the env var, nothing changes for any caller.
        expect(() => applyWriteEnvelope(sourced(), undefined, { isCreate: false })).not.toThrow();
        expect(() => applyWriteEnvelope(sourced())).not.toThrow();   // default is OFF
    });

    it('OFF + the generic default: allowed', () => {
        expect(() => applyWriteEnvelope(sourced('calendar-mcp'), undefined, { isCreate: false }))
            .not.toThrow();
    });

    it('validateCreatePayload is the rule itself, independent of the switch', () => {
        const ok = sourced('term-doc:redhill-2026-t3');
        applyWriteEnvelope(ok);                       // stamp it so the base gate passes
        expect(() => validateCreatePayload(ok)).not.toThrow();
        const bad = sourced('calendar-mcp');
        applyWriteEnvelope(bad);
        expect(() => validateCreatePayload(bad)).toThrow(/generic default/);
    });
});

describe('ensureEnvelope', () => {
    it('fills a bare body and the result passes the gate', () => {
        const body: any = { summary: 'x' };
        ensureEnvelope(body);
        expect(() => validatePayload(body)).not.toThrow();
        expect(body.extendedProperties.private.claudia_schema).toBe('2');
    });

    it('never overwrites a caller value', () => {
        const body: any = {
            summary: 'x',
            location: 'Roedean School',
            extendedProperties: {
                private: {
                    claudia_loc_policy: 'resolved',
                    claudia_loc_confidence: 'high',
                    claudia_loc_source: 'venue_kb',
                    claudia_venue_id: 'roedean',
                    claudia_source: 'term-doc:redhill-2026-t3',
                },
            },
        };
        ensureEnvelope(body, 'should-not-win');
        const p = body.extendedProperties.private;
        expect(p.claudia_loc_policy).toBe('resolved');
        expect(p.claudia_source).toBe('term-doc:redhill-2026-t3');
        expect(() => validatePayload(body)).not.toThrow();
    });

    it('preserves the Trip Feed stamp and other foreign keys', () => {
        // stampClaudia() runs immediately before this in every handler; if the
        // envelope clobbered `claudia` the Trip Feed watcher would stop seeing
        // events it is supposed to pick up.
        const body: any = {
            summary: 'x',
            extendedProperties: { private: { claudia: '1', kb_school_id: 'evt_1', trip_id: 't1' } },
        };
        ensureEnvelope(body);
        const p = body.extendedProperties.private;
        expect(p.claudia).toBe('1');
        expect(p.kb_school_id).toBe('evt_1');
        expect(p.trip_id).toBe('t1');
        expect(() => validatePayload(body)).not.toThrow();
    });
});

describe('applyWriteEnvelope', () => {
    it('repairs a D3 description rather than rejecting it', () => {
        // Normalise runs BEFORE validate, so the ordinary case passes silently.
        // The assertion exists for when normalisation is skipped.
        const body: any = { summary: 'x', description: 'Junior School\\nSource: Term 3' };
        applyWriteEnvelope(body);
        expect(body.description).toBe('Junior School\nSource: Term 3');
    });

    it('flattens an escape in the title instead of making a real newline', () => {
        const body: any = { summary: 'Spring Day\\nGrace' };
        applyWriteEnvelope(body);
        expect(body.summary).toBe('Spring Day Grace');
    });

    it('still rejects a self-contradictory payload', () => {
        const body: any = {
            summary: 'x',
            location: 'Redhill School',
            extendedProperties: { private: { claudia_loc_policy: 'on_campus_no_travel' } },
        };
        expect(() => applyWriteEnvelope(body)).toThrow(PayloadValidationError);
    });
});

