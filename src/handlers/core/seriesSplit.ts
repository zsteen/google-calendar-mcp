/**
 * What a `thisAndFollowing` split may do to a series' stored properties.
 *
 * The split truncates the original series with an UNTIL and INSERTS a new one
 * built from `{...original, ...requestBody}`. `requestBody.extendedProperties`
 * always exists (the envelope), so the spread replaced the original's private
 * map wholesale: the new series lost everything the old one knew. Dropping
 * everything is wrong, and so is keeping everything - so the rule is per key.
 *
 *   carried     `trip_id` (same event, same trip); `claudia_time_precision` /
 *               `claudia_time_window` when the caller did not set a new time -
 *               a placeholder is still a placeholder. `claudia` is stamped on
 *               every body already; source and the location claim come from
 *               `preserveStoredEnvelope`, which the body has been through.
 *   never       `claudia_natural_key`, `claudia_key_version`,
 *               `claudia_content_hash`, `claudia_written_start/_end`. A key must
 *               name ONE row: two rows under one key, and the next ingest
 *               patches or reconciles the wrong one.
 *   refused     a series carrying `kb_school_id` is not split at all - see
 *               `linkedSeriesRefusal`.
 */
import { calendar_v3 } from 'googleapis';

const CARRIED_ALWAYS = ['trip_id'] as const;
const CARRIED_IF_TIME_UNCHANGED = ['claudia_time_precision', 'claudia_time_window'] as const;

function privateOf(event: calendar_v3.Schema$Event | null | undefined): Record<string, unknown> {
    return (event?.extendedProperties?.private ?? {}) as Record<string, unknown>;
}

const text = (v: unknown) => String(v ?? '').trim();

/**
 * Why a `thisAndFollowing` split of this series must be refused, or null.
 *
 * A series carrying `kb_school_id` is the calendar projection of a kb-school
 * weekday activity, and the pause/cancel reconciler OWNS its recurrence: every
 * 12 minutes it makes the series equal `canonical(activity) minus pauses`. A
 * split writes an UNTIL the reconciler did not put there, so its next pass
 * removes it - and the truncated series and the new one then run side by side.
 * The change belongs in kb-school, which the reconciler mirrors.
 */
export function linkedSeriesRefusal(original: calendar_v3.Schema$Event | null | undefined): string | null {
    const link = text(privateOf(original).kb_school_id);
    if (!link) return null;
    return (
        `This series is linked to a kb-school activity (kb_school_id=${link}), and the ` +
        `pause/cancel reconciler owns its recurrence: it would undo a thisAndFollowing split ` +
        `within minutes and leave two series running side by side. Nothing was changed. ` +
        `Change the ACTIVITY in kb-school instead (its day, time or venue; or pause / cancel it) ` +
        `and the reconciler mirrors it to the calendar. For a one-off change use ` +
        `modificationScope thisEventOnly.`
    );
}

/**
 * Add to `body` the original's properties that belong on the new series.
 * Fill-if-absent: anything the body already says (a caller's own value, the
 * envelope, what `preserveStoredEnvelope` kept) is left alone.
 */
export function carrySplitSeriesProperties(
    body: calendar_v3.Schema$Event,
    original: calendar_v3.Schema$Event | null | undefined,
    opts: { timeChanged: boolean },
): void {
    const kept = privateOf(original);
    const ext = body.extendedProperties ?? (body.extendedProperties = {});
    const priv = (ext.private ?? (ext.private = {})) as Record<string, string>;
    const keys: string[] = [...CARRIED_ALWAYS, ...(opts.timeChanged ? [] : CARRIED_IF_TIME_UNCHANGED)];
    for (const key of keys) {
        const value = text(kept[key]);
        if (value && !text(priv[key])) priv[key] = value;
    }
}
