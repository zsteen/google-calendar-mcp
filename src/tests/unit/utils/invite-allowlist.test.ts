import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadInviteAllowlist, resolveSendUpdates, _resetCacheForTests } from '../../../utils/invite-allowlist.js';

describe('Phase 7f — invite-allowlist loader (fail-safe)', () => {
    let tmpDir: string;
    let tmpFile: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-7f-invite-'));
        tmpFile = path.join(tmpDir, 'invite-allowlist.txt');
        process.env.CALENDAR_INVITE_ALLOWLIST_PATH = tmpFile;
        _resetCacheForTests();
    });

    afterEach(() => {
        delete process.env.CALENDAR_INVITE_ALLOWLIST_PATH;
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        _resetCacheForTests();
    });

    it('returns an EMPTY set when the file is missing (fail-safe, never throws)', () => {
        expect(() => loadInviteAllowlist()).not.toThrow();
        expect(loadInviteAllowlist().size).toBe(0);
    });

    it('reads one email per line, lower-cased', () => {
        fs.writeFileSync(tmpFile, 'Bruce.Steen@Example.com\nziegrid.steen@rmb.co.za\n');
        const set = loadInviteAllowlist();
        expect(set.size).toBe(2);
        expect(set.has('bruce.steen@example.com')).toBe(true);
        expect(set.has('ziegrid.steen@rmb.co.za')).toBe(true);
    });

    it('strips # comments and blank lines', () => {
        fs.writeFileSync(tmpFile, [
            '# invite allowlist',
            '',
            'bruce@example.com  # Bruce',
            '   ',
            'zig@rmb.co.za',
            '# trailing',
        ].join('\n'));
        const set = loadInviteAllowlist();
        expect(set.size).toBe(2);
    });

    it('caches across calls when mtime is unchanged', () => {
        fs.writeFileSync(tmpFile, 'a@b.com\n');
        expect(loadInviteAllowlist()).toBe(loadInviteAllowlist());
    });

    it('refreshes when mtime changes (add an address without restart)', () => {
        fs.writeFileSync(tmpFile, 'a@b.com\n');
        expect(loadInviteAllowlist().has('added@b.com')).toBe(false);

        const future = new Date(Date.now() + 5000);
        fs.writeFileSync(tmpFile, 'a@b.com\nadded@b.com\n');
        fs.utimesSync(tmpFile, future, future);

        expect(loadInviteAllowlist().has('added@b.com')).toBe(true);
    });
});

describe('Phase 7f — resolveSendUpdates', () => {
    let tmpDir: string;
    let tmpFile: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-7f-invite-'));
        tmpFile = path.join(tmpDir, 'invite-allowlist.txt');
        process.env.CALENDAR_INVITE_ALLOWLIST_PATH = tmpFile;
        _resetCacheForTests();
        fs.writeFileSync(tmpFile, 'bruce@example.com\nzig@rmb.co.za\n');
    });

    afterEach(() => {
        delete process.env.CALENDAR_INVITE_ALLOWLIST_PATH;
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        _resetCacheForTests();
    });

    it('no attendees => none', () => {
        expect(resolveSendUpdates(undefined)).toEqual({ sendUpdates: 'none', skipped: [] });
        expect(resolveSendUpdates([])).toEqual({ sendUpdates: 'none', skipped: [] });
    });

    it("all attendees on the allowlist => all (email them), case-insensitive", () => {
        const r = resolveSendUpdates([{ email: 'Bruce@Example.com' }, { email: 'zig@rmb.co.za' }]);
        expect(r).toEqual({ sendUpdates: 'all', skipped: [] });
    });

    it('any off-list attendee => none, and lists the off-list address in skipped', () => {
        const r = resolveSendUpdates([{ email: 'bruce@example.com' }, { email: 'stranger@nowhere.com' }]);
        expect(r.sendUpdates).toBe('none');
        expect(r.skipped).toEqual(['stranger@nowhere.com']);
    });

    it('attendee with no email is treated as off-list => none', () => {
        const r = resolveSendUpdates([{ email: 'bruce@example.com' }, { email: '' }]);
        expect(r.sendUpdates).toBe('none');
    });

    it('missing allowlist file => none even for a would-be guest (fail-safe)', () => {
        fs.unlinkSync(tmpFile);
        _resetCacheForTests();
        const r = resolveSendUpdates([{ email: 'bruce@example.com' }]);
        expect(r.sendUpdates).toBe('none');
        expect(r.skipped).toEqual(['bruce@example.com']);
    });

    // Regression (2026-08-03): Google returns the calendar owner as an attendee on
    // every fetched event, and DeleteEventHandler gates on that list -- counting the
    // owner as a guest suppressed EVERY cancellation email.
    it('ignores the calendar owner Google echoes back (self/organizer)', () => {
        const r = resolveSendUpdates([
            { email: 'bruce@example.com' },
            { email: 'owner@gmail.com', organizer: true, self: true },
            { email: 'zig@rmb.co.za' },
        ]);
        expect(r).toEqual({ sendUpdates: 'all', skipped: [] });
    });

    it('owner-only attendee list => none (no guests to notify)', () => {
        const r = resolveSendUpdates([{ email: 'owner@gmail.com', organizer: true, self: true }]);
        expect(r).toEqual({ sendUpdates: 'none', skipped: [] });
    });
});
