/**
 * S1 (Claudia write-path tracker, 2026-09-27): a daily or weekly series must say
 * when it ends.
 *
 * Grace's Wednesday art class was written on 5 Jul with `RRULE:FREQ=WEEKLY` and
 * nothing else, so it would have printed a 15:15 pickup every Wednesday forever,
 * through every holiday. The three series written on 23 Sep carried the term's
 * end (UNTIL 13 Nov) because the instruction said to; the art class shows an
 * instruction is not an enforcement (the same lesson as C26/C27).
 *
 * Refused: an RRULE with FREQ=DAILY or FREQ=WEEKLY and neither UNTIL nor COUNT.
 * Allowed: anything bounded, and MONTHLY/YEARLY (a birthday or an anniversary
 * legitimately has no end). EXDATE/RDATE lines are not rules and are ignored.
 *
 * Behind a switch, defaulting OFF, exactly like CALENDAR_REQUIRE_CREATE_SOURCE:
 * `create-event` is a general MCP tool and this repo's own upstream tests create
 * open-ended weekly series 25 times; and on a live family calendar a misfire
 * must be undoable with one config value and a restart.
 */

const OPEN_ENDED_FREQS = new Set(['DAILY', 'WEEKLY']);

export function seriesEndRequired(): boolean {
    return process.env.CALENDAR_REQUIRE_SERIES_END === '1';
}

/** The first open-ended DAILY/WEEKLY RRULE in `recurrence`, or null. Pure. */
export function openEndedRule(recurrence: unknown): string | null {
    if (!Array.isArray(recurrence)) return null;
    for (const raw of recurrence) {
        const line = String(raw ?? '').trim();
        if (!/^RRULE:/i.test(line)) continue;
        const parts = new Map<string, string>();
        for (const kv of line.slice(line.indexOf(':') + 1).split(';')) {
            const [k, v] = kv.split('=');
            if (k) parts.set(k.trim().toUpperCase(), (v ?? '').trim().toUpperCase());
        }
        const freq = parts.get('FREQ') ?? '';
        if (OPEN_ENDED_FREQS.has(freq) && !parts.has('UNTIL') && !parts.has('COUNT')) {
            return line;
        }
    }
    return null;
}

/** Throws when the switch is on and `recurrence` would repeat forever. */
export function assertSeriesHasEnd(recurrence: unknown): void {
    if (!seriesEndRequired()) return;
    const rule = openEndedRule(recurrence);
    if (rule) {
        throw new Error(
            `Refused: this repeating event has no end date (${rule}). ` +
            `Add UNTIL=<last date> (for a school activity, the term's co-curricular end) ` +
            `or COUNT=<number of sessions> to the RRULE, then try again. ` +
            `A daily or weekly series without an end keeps writing itself forever.`
        );
    }
}
