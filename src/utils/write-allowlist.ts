// Phase 7f write allowlist (PHASE-7F-SPEC.md §3 Patch B).
//
// Calendar IDs in this allowlist are the ONLY ones the create/update/delete
// handlers will operate on. The check runs AFTER getClientWithAutoSelection
// resolves a calendar name to its actual ID, so an allowed name that resolves
// to an out-of-allowlist ID is still refused.
//
// File path:  ~/.openclaw/config/google-calendar/write-allowlist.txt
//   (override via env CALENDAR_WRITE_ALLOWLIST_PATH)
//
// Refresh:    mtime-based — edits to the file take effect on the next call
//             without an MCP restart. Critical for revocation scenarios.
// Failure:    if the file is missing, the loader throws. Write handlers fail
//             loud rather than silently allowing everything.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface AllowlistCache {
    set: Set<string>;
    mtimeMs: number;
}
let cache: AllowlistCache | null = null;

function allowlistPath(): string {
    return process.env.CALENDAR_WRITE_ALLOWLIST_PATH
        ?? path.join(os.homedir(), '.openclaw/config/google-calendar/write-allowlist.txt');
}

export function loadWriteAllowlist(): Set<string> {
    const p = allowlistPath();
    if (!fs.existsSync(p)) {
        cache = null;
        throw new Error(
            `Calendar write allowlist not found at ${p}. ` +
            `Phase 7f requires this file to enable write tools.`
        );
    }
    const stat = fs.statSync(p);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.set;

    const lines = fs.readFileSync(p, 'utf-8').split('\n');
    const set = new Set(
        lines
            .map(l => l.split('#')[0].trim())
            .filter(l => l.length > 0)
    );
    cache = { set, mtimeMs: stat.mtimeMs };
    return set;
}

export function assertWritable(calendarId: string): void {
    const allowed = loadWriteAllowlist();
    if (!allowed.has(calendarId)) {
        throw new Error(
            `Calendar '${calendarId}' is not in the Phase 7f write allowlist. ` +
            `Writable calendars: ${[...allowed].join(', ')}.`
        );
    }
}

// Test-only helper. Production callers must NOT touch the cache.
export function _resetCacheForTests(): void {
    cache = null;
}
