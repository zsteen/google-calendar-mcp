/**
 * Venue KB at the write boundary — the TypeScript half of tracker R2 (C47).
 *
 * A port of `calendar_envelope/venues.py::VenueGraph.resolve` and
 * `calendar_envelope/venue_kb.py::classify_location_at_write`. The Python module
 * is the reference and `venue-vectors.json` is the contract: every case there
 * must resolve identically here, and both suites assert it.
 *
 * WHY THIS EXISTS. `claudia_loc_confidence` has been a required envelope field
 * since Phase 0, and until 2026-09-18 no live writer ever set it — the agent's
 * own creates come through this handler, `ensureEnvelope` filled the
 * pessimistic default, and every `high` on the calendar was a backfill script's.
 * The resolver's answer existed for one turn in the agent (`lookup_venue`) and
 * was dropped at the write.
 *
 * WHAT IT DOES. When the body carries a location and the caller has not already
 * classified it, resolve against `known-venues.yml` and stamp what the offline
 * policy backfill would have: `resolved` / `high` / `venue_kb` + venue identity.
 * A location the KB does not know stays `unclassified` — honest, and what the
 * Sunday auditor counts. It never invents `on_campus_no_travel` or
 * `unresolved_tbc` (product decisions about an EMPTY location), never overrides
 * a caller's explicit policy, never geocodes, and fails OPEN: no KB, an
 * unreadable KB → the body is left exactly as it was.
 *
 * Matching, in order, exactly as the reference documents it:
 *   1. the whole normalised string is a venue token (name, address or alias);
 *   2. the first comma-segment — the venue NAME — is a token. Never a raw
 *      prefix: `startsWith` sent "Fourways High School, …" to `fourways-mall`;
 *   3. the street signature (`number street [suffix]`, suffix-normalised)
 *      equals a venue's curated address signature, and only ONE venue owns it.
 */
import { readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { calendar_v3 } from 'googleapis';
import {
    K_LOC_CONFIDENCE, K_LOC_POLICY, K_LOC_SOURCE, K_VENUE_ID, K_VENUE_KIND,
    POLICY_RESOLVED, POLICY_UNCLASSIFIED,
} from './calendarEnvelope.js';

export const KIND_PHYSICAL = 'physical';

export interface Venue {
    id: string;
    name: string;
    address: string;
    aliases: string[];
    placeId: string | null;
    parentVenue: string | null;
    kind: string;
}

/** Loose match key: accents folded, punctuation flattened, case dropped. */
export function norm(s: string | null | undefined): string {
    const d = (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return d.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const STREET_SUFFIXES: Record<string, string> = {
    rd: 'road', road: 'road', ave: 'avenue', av: 'avenue', avenue: 'avenue',
    st: 'street', street: 'street', dr: 'drive', drive: 'drive', ln: 'lane', lane: 'lane',
    cres: 'crescent', crescent: 'crescent', blvd: 'boulevard', boulevard: 'boulevard',
    place: 'place', way: 'way', terrace: 'terrace', close: 'close',
};
const STREET_RE = new RegExp(
    '\\b(\\d+[a-z]?)\\s+([a-z]+)(?:\\s+(' + Object.keys(STREET_SUFFIXES).sort().join('|') + '))?\\b');

/** `street-number street-name [suffix]` from an address, or null. */
// Bare compass words are never a street NAME. "…, 2057, South Africa" otherwise
// matches as street "2057 South" — a postcode wearing the country as its name.
// Known since 18 Sep as `2196 south` and called harmless because ambiguous
// signatures never resolve; that held only because six venues share 2196.
// `2057 south` had ONE owner (redhill-outspan, no street number in its curated
// address) so it resolved, and a dentist in postcode 2057 came back a school.
// A real "South Road" still signs — the suffix is what makes it a street.
const NOT_STREET_NAMES = new Set(['south', 'north', 'east', 'west']);

export function addressSignature(text: string | null | undefined): string | null {
    if (!text) return null;
    const m = STREET_RE.exec(norm(text));
    if (!m) return null;
    const [, num, word, suffix] = m;
    if (NOT_STREET_NAMES.has(word) && suffix === undefined) return null;
    if (word in STREET_SUFFIXES && suffix === undefined) return `${num} ${STREET_SUFFIXES[word]}`;
    const base = `${num} ${word}`;
    return suffix ? `${base} ${STREET_SUFFIXES[suffix]}` : base;
}

export function loadVenues(rows: unknown): Venue[] {
    if (!Array.isArray(rows)) return [];
    const out: Venue[] = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object' || (row as any).id === undefined) continue;
        const r = row as Record<string, unknown>;
        const pid = r.place_id;
        out.push({
            id: String(r.id),
            name: String(r.name ?? ''),
            address: String(r.address ?? ''),
            aliases: Array.isArray(r.aliases) ? r.aliases.map((a) => String(a)) : [],
            placeId: pid === null || pid === undefined || pid === '' || pid === 'null' ? null : String(pid),
            parentVenue: r.parent_venue ? String(r.parent_venue) : null,
            kind: String(r.venue_kind ?? r.kind ?? KIND_PHYSICAL),
        });
    }
    return out;
}

export class VenueGraph {
    readonly venues = new Map<string, Venue>();
    private readonly tokens = new Map<string, string>();
    private readonly signatures = new Map<string, string>();
    readonly ambiguousSignatures = new Set<string>();

    constructor(venues: Iterable<Venue>) {
        for (const v of venues) this.venues.set(v.id, v);
        for (const v of this.venues.values()) {
            for (const raw of [v.name, v.address, ...v.aliases]) {
                const tok = norm(raw);
                if (tok && !this.tokens.has(tok)) this.tokens.set(tok, v.id);
            }
        }
        const owners = new Map<string, Set<string>>();
        for (const v of this.venues.values()) {
            const sig = addressSignature(v.address);
            if (!sig) continue;
            if (!owners.has(sig)) owners.set(sig, new Set());
            owners.get(sig)!.add(v.id);
        }
        for (const [sig, ids] of owners) {
            if (ids.size === 1) this.signatures.set(sig, [...ids][0]);
            else this.ambiguousSignatures.add(sig);
        }
    }

    /** Exact token, then the first comma-segment, then the address rule. Never a guess. */
    resolve(location: string | null | undefined): Venue | null {
        if (!location || !location.trim()) return null;
        const key = norm(location);
        if (this.tokens.has(key)) return this.venues.get(this.tokens.get(key)!)!;
        const first = norm(location.split(',')[0]);
        if (first && this.tokens.has(first)) return this.venues.get(this.tokens.get(first)!)!;
        const sig = addressSignature(location);
        if (sig && this.signatures.has(sig)) return this.venues.get(this.signatures.get(sig)!)!;
        return null;
    }
}

// ─── the KB on disk, reloaded when it changes, a failure never permanent ─────
export const DEFAULT_VENUES_PATH =
    process.env.CLAUDIA_VENUES_PATH || join(homedir(), '.openclaw', 'config', 'google-calendar', 'known-venues.yml');

let graph: VenueGraph | null = null;
let loadedKey: string | null = null;
let loadError: string | null = null;

export function defaultGraph(path?: string): VenueGraph | null {
    const target = path || DEFAULT_VENUES_PATH;
    let key: string;
    try {
        key = `${target}|${statSync(target).mtimeMs}`;
    } catch (e) {
        if (graph === null) loadError = `cannot stat ${target}: ${(e as Error).message}`;
        return graph;
    }
    if (graph !== null && loadedKey === key) return graph;
    try {
        const raw = parseYaml(readFileSync(target, 'utf8')) ?? {};
        graph = new VenueGraph(loadVenues((raw as any).venues ?? []));
        loadedKey = key;
        loadError = null;
    } catch (e) {
        loadError = (e as Error).message;   // keep the last good graph; retry next call
    }
    return graph;
}

export function resetVenueCache(): void { graph = null; loadedKey = null; loadError = null; }
export function venueLoadError(): string | null { return loadError; }

/**
 * Fill the location envelope fields from the KB when the caller left them at
 * the default. Returns the venue id stamped, or null when nothing changed.
 * Runs BEFORE `ensureEnvelope` (fill-if-absent, so this survives) and before
 * the gate (which then checks it). Idempotent.
 */
export function classifyLocationAtWrite(
    body: calendar_v3.Schema$Event, opts?: { graph?: VenueGraph | null; path?: string },
): string | null {
    const location = body.location;
    if (typeof location !== 'string' || !location.trim()) return null;
    const ext = body.extendedProperties;
    const priv: Record<string, string> =
        ext && typeof ext === 'object' && ext.private && typeof ext.private === 'object'
            ? (ext.private as Record<string, string>) : {};
    const policy = String(priv[K_LOC_POLICY] ?? '');
    if (policy && policy !== POLICY_UNCLASSIFIED) return null;   // the caller decided
    const g = opts?.graph !== undefined ? opts.graph : defaultGraph(opts?.path);
    if (!g) return null;                                            // fail open
    const venue = g.resolve(location);
    if (!venue) return null;                                        // honest: unclassified
    priv[K_LOC_POLICY] = POLICY_RESOLVED;
    priv[K_LOC_CONFIDENCE] = 'high';
    priv[K_LOC_SOURCE] = 'venue_kb';
    priv[K_VENUE_ID] = venue.id;
    priv[K_VENUE_KIND] = venue.kind;
    if (!body.extendedProperties || typeof body.extendedProperties !== 'object') body.extendedProperties = {};
    body.extendedProperties.private = priv;
    return venue.id;
}
