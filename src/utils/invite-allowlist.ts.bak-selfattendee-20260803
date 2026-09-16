// Phase 7f — guest invite allowlist (PHASE-7F-GUEST-INVITE-SPEC.md).
//
// Controls whether Claudia may EMAIL a calendar invitation to attendees.
// Google emails guests only when sendUpdates is 'all' (or 'externalOnly').
// The base Phase 7f patch hardcodes 'none' so no guest is ever emailed; this
// module relaxes that ONLY for attendees whose email is on the allowlist.
//
// File path:  ~/.openclaw/config/google-calendar/invite-allowlist.txt
//   (override via env CALENDAR_INVITE_ALLOWLIST_PATH)
//
// Refresh:    mtime-based — edits (add/revoke an address) take effect on the
//             next call without an MCP restart. Same pattern as write-allowlist.
//
// Failure:    DELIBERATELY FAIL-SAFE. A missing/unreadable file means "email
//             nobody" (empty set) — it NEVER blocks event creation and NEVER
//             emails everyone. This is the opposite of write-allowlist, which
//             fails loud: there, absence must stop all writes; here, absence
//             must only stop notifications.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface AllowlistCache {
    set: Set<string>;
    mtimeMs: number;
}
let cache: AllowlistCache | null = null;

function allowlistPath(): string {
    return process.env.CALENDAR_INVITE_ALLOWLIST_PATH
        ?? path.join(os.homedir(), '.openclaw/config/google-calendar/invite-allowlist.txt');
}

export function loadInviteAllowlist(): Set<string> {
    const p = allowlistPath();
    if (!fs.existsSync(p)) {
        cache = null;
        return new Set();               // fail SAFE: email nobody, never throw
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(p);
    } catch {
        cache = null;
        return new Set();               // unreadable => email nobody
    }
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.set;

    const lines = fs.readFileSync(p, 'utf-8').split('\n');
    const set = new Set(
        lines
            .map(l => l.split('#')[0].trim().toLowerCase())   // strip comments, normalise case
            .filter(l => l.length > 0)
    );
    cache = { set, mtimeMs: stat.mtimeMs };
    return set;
}

export type SendUpdatesSetting = 'all' | 'none';

/**
 * Decide the Google `sendUpdates` value for a set of attendees.
 *
 * Returns 'all' (notify every guest) ONLY when there is at least one attendee
 * AND every attendee's email is on the invite allowlist. If ANY attendee is
 * off-list (or has no parseable email), returns 'none' and lists the off-list
 * addresses in `skipped` so the caller can surface "I did not email X".
 *
 * Never throws — a bad allowlist file degrades to 'none' (email nobody).
 */
export function resolveSendUpdates(
    attendees?: Array<{ email?: string | null }> | null
): { sendUpdates: SendUpdatesSetting; skipped: string[] } {
    const list = attendees ?? [];
    if (list.length === 0) {
        return { sendUpdates: 'none', skipped: [] };
    }
    const allowed = loadInviteAllowlist();
    // Account for EVERY attendee. Any one that is off-list — or that has no usable
    // email (can't be verified) — downgrades the whole event to 'none' (email nobody).
    // "If I can't vouch for all of them, I email none of them."
    const skipped: string[] = [];
    for (const a of list) {
        const email = (a?.email ?? '').trim().toLowerCase();
        if (email.length === 0) {
            skipped.push('(attendee without an email address)');
        } else if (!allowed.has(email)) {
            skipped.push(email);
        }
    }
    return skipped.length > 0
        ? { sendUpdates: 'none', skipped }
        : { sendUpdates: 'all', skipped: [] };
}

// Test-only helper. Production callers must NOT touch the cache.
export function _resetCacheForTests(): void {
    cache = null;
}
