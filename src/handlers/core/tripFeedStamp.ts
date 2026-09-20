/**
 * Trip Feed stamp + poke (TRIP-FEED-CALENDAR-SPEC WP4, Claudia repo, 2026-08-20).
 *
 * Every event this MCP writes gets a private extendedProperty stamp, and the
 * Trip Feed watcher on this VPS is poked to run immediately after any write.
 * The stamp is the watcher's qualifier: only Claudia-written events inside a
 * linked trip's window become itinerary items in the travel app - calendar
 * noise (school runs, work calls) never leaks in. The poke is latency only:
 * the 15-minute cron is the safety net, so both helpers are best-effort and
 * must never fail a calendar write.
 */
import { spawn } from 'child_process';
import { calendar_v3 } from 'googleapis';

const STAMP_KEY = 'claudia';
const STAMP_VALUE = '1';
const FEED_CWD = process.env.TRIP_FEED_CWD || '/home/claudia/Claudia';

export function stampClaudia(body: calendar_v3.Schema$Event): void {
    const ext = body.extendedProperties ?? (body.extendedProperties = {});
    const priv = ext.private ?? (ext.private = {});
    (priv as Record<string, string>)[STAMP_KEY] = STAMP_VALUE;
}

export function pokeTripFeed(eventId?: string | null): void {
    try {
        const args = ['-m', 'control_centre.trip_feed'];
        if (eventId) args.push('--event', String(eventId));
        const child = spawn('python3', args, { cwd: FEED_CWD, detached: true, stdio: 'ignore' });
        child.unref();
    } catch {
        /* best-effort - the cron pass picks it up within 15 minutes */
    }
}
