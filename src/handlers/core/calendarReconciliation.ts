/**
 * The reconciliation ledger, read side — TypeScript half (task 3.1d).
 *
 * A deliberate PORT of `phase-shared/calendar_envelope/reconciliation.py`.
 * Reads the ledger, and appends ONE kind of record: a `revived`. It never
 * cancels — only `scripts/reconcile_source.py` does that.
 *
 * WHY IT MUST WRITE THAT ONE RECORD. A revive that does not clear the key
 * leaves a standing licence to resurrect. The key would still read
 * "cancelled-by-reconciliation" forever, so if the row were later deleted BY
 * HAND, the next re-ingest would revive a human's deletion — and a UI deletion
 * records nothing in the suppression store, so nothing else would stop it. The
 * append is what closes that, which is why the Python half records a revive too.
 *
 * The connector needs the file to answer one question before it suppresses a
 * cancelled row — "did we cancel this ourselves?" — and answering it wrongly in
 * either direction is a real harm:
 *
 *   wrongly REVIVE   -> resurrects an event a human deliberately deleted
 *   wrongly SUPPRESS -> a school drops a date by mistake, fixes its calendar
 *                       next week, and the event never comes back, forever,
 *                       for a reason nobody can see
 *
 * WHY THIS IS NOT THE SUPPRESSION STORE. They look alike and mean opposite
 * things: the suppression store records a USER's decision, this records a
 * DOCUMENT's current revision. The connector never needs to read the
 * suppression store, because the Python `create_idempotent` path consults it
 * before the insert and the agent path has no user-deletion concept of its own.
 *
 * CANONICAL SOURCE: Claudia repo, phase-shared/calendar_envelope/calendarReconciliation.ts
 * Deployed to:      google-calendar-mcp-fork/src/handlers/core/calendarReconciliation.ts
 */
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/** Same default and same env override as the Python half, so the two cannot
 *  disagree about which file is the ledger. */
export function reconciliationPath(): string {
    return process.env.CLAUDIA_RECONCILIATION_PATH
        || join(homedir(), '.openclaw', 'state', 'calendar-reconciliation.jsonl');
}

/**
 * Natural keys currently cancelled-by-reconciliation.
 *
 * Replay semantics are the port's contract: records are append-only and the
 * LAST action for a key wins, so a `revived` record clears a key that an
 * earlier `cancelled` record set. Mirrors `ReconciliationLedger.cancelled_keys`.
 *
 * A malformed line is skipped rather than fatal — for the reason the Python
 * docstring gives: one bad line disabling the whole ledger would silently turn
 * every document-drop into a permanent suppression, which is the exact failure
 * the ledger exists to prevent.
 *
 * A MISSING file is not an error. It is the normal state: measured on the VPS
 * 2026-09-15, the file does not exist because nothing has ever been reconciled
 * out. Returns an empty set, so every cancelled row suppresses — the pre-3.1d
 * behaviour.
 */
export function reconciledKeys(path?: string): Set<string> {
    let text: string;
    try {
        text = readFileSync(path || reconciliationPath(), 'utf-8');
    } catch {
        return new Set();          // absent or unreadable -> revive nothing
    }

    const state = new Map<string, boolean>();
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: any;
        try { rec = JSON.parse(trimmed); } catch { continue; }
        const key = rec?.natural_key;
        if (!key || typeof key !== 'string') continue;
        // Default 'cancelled' matches the Python reader: a record that names a
        // key but no action is a cancel.
        state.set(key, (rec.action ?? 'cancelled') === 'cancelled');
    }
    return new Set([...state.entries()].filter(([, on]) => on).map(([k]) => k));
}

/**
 * Record that a reconciled-out key is live again, clearing it from
 * `reconciledKeys`. Mirrors `ReconciliationLedger.record_revive`, field for
 * field, so one reader can parse records written by either language.
 *
 * Returns false if the append failed. The caller has already patched the row
 * back to `confirmed` by this point, so a failure here is not worth undoing a
 * good write over — but it does leave the key set, which is the residual risk
 * named in this file's header, so it is reported rather than swallowed.
 */
export function recordRevive(
    args: { naturalKey: string; source: string; eventId: string },
    path?: string,
): boolean {
    const target = path || reconciliationPath();
    const record = {
        at: new Date().toISOString(),
        action: 'revived',
        natural_key: args.naturalKey,
        source: args.source,
        event_id: args.eventId,
        reason: 'the document lists this row again',
    };
    try {
        mkdirSync(dirname(target), { recursive: true });
        appendFileSync(target, JSON.stringify(record) + '\n', 'utf-8');
        return true;
    } catch {
        return false;
    }
}
