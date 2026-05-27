import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadWriteAllowlist, assertWritable, _resetCacheForTests } from '../../../utils/write-allowlist.js';

describe('Phase 7f — write-allowlist loader', () => {
    let tmpDir: string;
    let tmpFile: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-7f-test-'));
        tmpFile = path.join(tmpDir, 'allowlist.txt');
        process.env.CALENDAR_WRITE_ALLOWLIST_PATH = tmpFile;
        _resetCacheForTests();
    });

    afterEach(() => {
        delete process.env.CALENDAR_WRITE_ALLOWLIST_PATH;
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        _resetCacheForTests();
    });

    it('throws when the file is missing', () => {
        expect(() => loadWriteAllowlist()).toThrow(/not found/);
    });

    it('reads one calendar ID per line', () => {
        fs.writeFileSync(tmpFile, 'household@group.calendar.google.com\nzig@gmail.com\n');
        const set = loadWriteAllowlist();
        expect(set.size).toBe(2);
        expect(set.has('household@group.calendar.google.com')).toBe(true);
        expect(set.has('zig@gmail.com')).toBe(true);
    });

    it('strips # comments and blank lines', () => {
        fs.writeFileSync(tmpFile, [
            '# header comment',
            '',
            'household@group.calendar.google.com  # household claudia',
            '   ',
            'zig@gmail.com',
            '# trailing',
            '',
        ].join('\n'));
        const set = loadWriteAllowlist();
        expect(set.size).toBe(2);
        expect(set.has('household@group.calendar.google.com')).toBe(true);
        expect(set.has('zig@gmail.com')).toBe(true);
    });

    it('caches across calls when mtime is unchanged', () => {
        fs.writeFileSync(tmpFile, 'a@b.com\n');
        const s1 = loadWriteAllowlist();
        const s2 = loadWriteAllowlist();
        expect(s1).toBe(s2); // same Set reference proves cache hit
    });

    it('refreshes when mtime changes (revocation case)', async () => {
        fs.writeFileSync(tmpFile, 'a@b.com\nrevoke-me@b.com\n');
        const s1 = loadWriteAllowlist();
        expect(s1.has('revoke-me@b.com')).toBe(true);

        // Bump mtime explicitly — same-second writes can collide on
        // filesystems with second-resolution mtime.
        const future = new Date(Date.now() + 5000);
        fs.writeFileSync(tmpFile, 'a@b.com\n');
        fs.utimesSync(tmpFile, future, future);

        const s2 = loadWriteAllowlist();
        expect(s2.has('revoke-me@b.com')).toBe(false);
        expect(s2.has('a@b.com')).toBe(true);
    });

    it('clears the cache when the file is removed (returns to fail-loud)', () => {
        fs.writeFileSync(tmpFile, 'a@b.com\n');
        loadWriteAllowlist();
        fs.unlinkSync(tmpFile);
        expect(() => loadWriteAllowlist()).toThrow(/not found/);
    });
});

describe('Phase 7f — assertWritable', () => {
    let tmpDir: string;
    let tmpFile: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-7f-test-'));
        tmpFile = path.join(tmpDir, 'allowlist.txt');
        process.env.CALENDAR_WRITE_ALLOWLIST_PATH = tmpFile;
        _resetCacheForTests();
        fs.writeFileSync(tmpFile, 'household@group.calendar.google.com\nzig@gmail.com\n');
    });

    afterEach(() => {
        delete process.env.CALENDAR_WRITE_ALLOWLIST_PATH;
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        _resetCacheForTests();
    });

    it('passes silently when calendarId is allowlisted', () => {
        expect(() => assertWritable('zig@gmail.com')).not.toThrow();
        expect(() => assertWritable('household@group.calendar.google.com')).not.toThrow();
    });

    it('throws with a descriptive message when calendarId is not allowlisted', () => {
        expect(() => assertWritable('eva-hockey@import.calendar.google.com')).toThrow(
            /not in the Phase 7f write allowlist/,
        );
    });

    it('throws even when calendarId is a substring of an allowlisted entry', () => {
        // Defends against substring-match attacks.
        expect(() => assertWritable('zig')).toThrow(/not in the Phase 7f write allowlist/);
    });
});
