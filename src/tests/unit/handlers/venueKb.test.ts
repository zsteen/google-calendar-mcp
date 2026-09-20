/**
 * venueKb.ts — the TypeScript half of tracker R2 (C47).
 *
 * Two contracts. (1) `venue-vectors.json`: the Python `VenueGraph.resolve` is the
 * reference and generated this file; every case must resolve identically here,
 * so a drift between the two implementations turns this suite red. (2) The
 * write-boundary behaviour: a known venue is stamped, a caller's own policy is
 * never overruled, an unknown venue stays unclassified, and no KB means no claim.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, unlinkSync, utimesSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    VenueGraph, addressSignature, classifyLocationAtWrite, loadVenues, norm,
    defaultGraph, resetVenueCache, venueLoadError,
} from '../../../handlers/core/venueKb.js';
import { applyWriteEnvelope } from '../../../handlers/core/calendarEnvelope.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(readFileSync(join(HERE, '../../../handlers/core/venue-vectors.json'), 'utf8'));
const GRAPH = new VenueGraph(loadVenues(VECTORS.venues));

const KB = `
venues:
  - id: redhill-summit
    name: Redhill School
    address: 20 Summit Rd, Morningside, Sandton, 2196
    aliases: ["Redhill School (Summit entrance)"]
    place_id: ChIJsummit
    venue_kind: physical
  - id: bona-bana
    name: Bona Bana Art School
    address: 138 Kelvin Drive, Morningside Manor, Johannesburg
    place_id: ChIJbona
`;

describe('venue-vectors.json — the contract with the Python resolver', () => {
    it('is a real contract, not a file of misses', () => {
        expect(VECTORS.version).toBe('1');
        expect(VECTORS.venues.length).toBeGreaterThanOrEqual(40);
        expect(VECTORS.cases.length).toBeGreaterThanOrEqual(100);
        expect(VECTORS.cases.filter((c: any) => c.venue_id).length).toBeGreaterThanOrEqual(30);
    });

    it('resolves every case exactly as Python recorded it', () => {
        const misses: string[] = [];
        for (const c of VECTORS.cases) {
            const v = GRAPH.resolve(c.location);
            const got = v ? v.id : null;
            const kind = v ? v.kind : null;
            if (got !== c.venue_id || kind !== c.venue_kind) {
                misses.push(`${JSON.stringify(c.location)}: expected ${c.venue_id}/${c.venue_kind}, got ${got}/${kind}`);
            }
        }
        expect(misses).toEqual([]);
    });

    it('agrees on which street signatures are ambiguous', () => {
        expect([...GRAPH.ambiguousSignatures].sort()).toEqual(VECTORS.ambiguous_signatures);
    });

    it('folds the way the Python _norm folds', () => {
        expect(norm('Café Del Sol — 45 Jan Smuts Ave')).toBe('cafe del sol 45 jan smuts ave');
        expect(addressSignature('Redhill School, 20 Summit Road, Morningside')).toBe('20 summit road');
        expect(addressSignature('20 Summit Rd')).toBe('20 summit road');
        expect(addressSignature('The 12 Apostles Hotel & Spa')).toBe('12 apostles');   // and no venue owns that
    });
});

describe('classifyLocationAtWrite', () => {
    const files: string[] = [];
    const kbFile = (text: string): string => {
        const p = join(tmpdir(), `venues-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
        writeFileSync(p, text, 'utf8');
        files.push(p);
        return p;
    };
    afterEach(() => {
        resetVenueCache();
        for (const f of files.splice(0)) { try { unlinkSync(f); } catch { /* gone */ } }
    });

    it('stamps a known venue before the envelope defaults land', () => {
        const body: any = { summary: 'Art', location: 'Bona Bana Art School, 138 Kelvin Drive' };
        expect(classifyLocationAtWrite(body, { path: kbFile(KB) })).toBe('bona-bana');
        applyWriteEnvelope(body);
        const p = body.extendedProperties.private;
        expect(p.claudia_loc_policy).toBe('resolved');
        expect(p.claudia_loc_confidence).toBe('high');
        expect(p.claudia_loc_source).toBe('venue_kb');
        expect(p.claudia_venue_id).toBe('bona-bana');
        expect(p.claudia_venue_kind).toBe('physical');
        expect(p.claudia_schema).toBe('2');
    });

    it('the address rule resolves a rendering the KB never listed', () => {
        const body: any = { location: 'Redhill School, 20 Summit Road, Morningside, Sandton' };
        expect(classifyLocationAtWrite(body, { path: kbFile(KB) })).toBe('redhill-summit');
    });

    it('an unknown venue stays honestly unclassified', () => {
        const body: any = { summary: 'x', location: 'Some Hall, 1 Nowhere St' };
        expect(classifyLocationAtWrite(body, { path: kbFile(KB) })).toBeNull();
        applyWriteEnvelope(body);
        expect(body.extendedProperties.private.claudia_loc_policy).toBe('unclassified');
        expect(body.extendedProperties.private.claudia_venue_id).toBeUndefined();
    });

    it('no location means no claim', () => {
        const body: any = { summary: 'x' };
        expect(classifyLocationAtWrite(body, { path: kbFile(KB) })).toBeNull();
        expect(body.extendedProperties).toBeUndefined();
    });

    it("never overrules a caller's own classification", () => {
        const body: any = {
            location: 'Bona Bana Art School',
            extendedProperties: { private: { claudia_loc_policy: 'resolved', claudia_loc_confidence: 'medium',
                                             claudia_loc_source: 'user_confirmed', claudia_venue_id: 'elsewhere' } },
        };
        expect(classifyLocationAtWrite(body, { path: kbFile(KB) })).toBeNull();
        expect(body.extendedProperties.private.claudia_venue_id).toBe('elsewhere');
        expect(body.extendedProperties.private.claudia_loc_confidence).toBe('medium');
    });

    it('other private keys survive (the Trip Feed stamp, kb_school_id)', () => {
        const body: any = { location: 'Bona Bana Art School',
                            extendedProperties: { private: { claudia: '1', kb_school_id: 'wda_1' } } };
        classifyLocationAtWrite(body, { path: kbFile(KB) });
        expect(body.extendedProperties.private.claudia).toBe('1');
        expect(body.extendedProperties.private.kb_school_id).toBe('wda_1');
        expect(body.extendedProperties.private.claudia_venue_id).toBe('bona-bana');
    });

    it('a missing KB fails open and says why', () => {
        const body: any = { location: 'Bona Bana Art School' };
        expect(classifyLocationAtWrite(body, { path: join(tmpdir(), 'no-such-venues.yml') })).toBeNull();
        expect(body.extendedProperties).toBeUndefined();
        expect(venueLoadError()).toMatch(/cannot stat/);
    });

    it('a changed KB is picked up without a restart', () => {
        const p = kbFile(KB);
        expect(defaultGraph(p)!.resolve('New Place')).toBeNull();
        writeFileSync(p, KB + '  - id: new-place\n    name: New Place\n    address: 9 New Rd\n', 'utf8');
        const t = statSync(p).mtime.getTime() / 1000 + 5;
        utimesSync(p, t, t);
        expect(defaultGraph(p)!.resolve('New Place')!.id).toBe('new-place');
    });
});
