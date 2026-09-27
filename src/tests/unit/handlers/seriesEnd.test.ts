import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { openEndedRule, assertSeriesHasEnd } from '../../../handlers/core/seriesEnd.js';
import { CreateEventHandler } from '../../../handlers/core/CreateEventHandler.js';
import { CreateEventsHandler } from '../../../handlers/core/CreateEventsHandler.js';
import { UpdateEventHandler } from '../../../handlers/core/UpdateEventHandler.js';
import { CalendarRegistry } from '../../../services/CalendarRegistry.js';

// S1 (Claudia write-path tracker, 2026-09-27): a daily/weekly series must end.
// Grace's art class was written with a bare `RRULE:FREQ=WEEKLY` on 5 Jul.

vi.mock('../../../utils/write-allowlist.js', () => ({ assertWritable: vi.fn() }));

const insert = vi.fn();
vi.mock('googleapis', () => ({
    google: { calendar: vi.fn(() => ({ events: { insert, get: vi.fn(), patch: vi.fn(), list: vi.fn() } })) },
    calendar_v3: {},
}));

const ART_CLASS = 'RRULE:FREQ=WEEKLY;BYDAY=WE';

describe('openEndedRule (pure)', () => {
    it('finds a bare weekly or daily rule', () => {
        expect(openEndedRule([ART_CLASS])).toBe(ART_CLASS);
        expect(openEndedRule(['RRULE:FREQ=DAILY'])).toBe('RRULE:FREQ=DAILY');
    });
    it('accepts a series that says when it ends', () => {
        expect(openEndedRule(['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261113T215959Z'])).toBeNull();
        expect(openEndedRule(['RRULE:FREQ=WEEKLY;COUNT=8'])).toBeNull();
        expect(openEndedRule(['rrule:freq=weekly;until=20261113'])).toBeNull();
    });
    it('leaves monthly and yearly alone (a birthday has no end)', () => {
        expect(openEndedRule(['RRULE:FREQ=YEARLY'])).toBeNull();
        expect(openEndedRule(['RRULE:FREQ=MONTHLY;BYMONTHDAY=25'])).toBeNull();
    });
    it('ignores EXDATE/RDATE lines and non-arrays', () => {
        expect(openEndedRule(['EXDATE;VALUE=DATE:20261104', 'RRULE:FREQ=WEEKLY;COUNT=3'])).toBeNull();
        expect(openEndedRule(['EXDATE;VALUE=DATE:20261104', ART_CLASS])).toBe(ART_CLASS);
        expect(openEndedRule(undefined)).toBeNull();
        expect(openEndedRule('RRULE:FREQ=WEEKLY')).toBeNull();
    });
});

describe('the switch', () => {
    const prior = process.env.CALENDAR_REQUIRE_SERIES_END;
    afterEach(() => {
        if (prior === undefined) delete process.env.CALENDAR_REQUIRE_SERIES_END;
        else process.env.CALENDAR_REQUIRE_SERIES_END = prior;
    });
    it('is off by default (the upstream suite creates open-ended series)', () => {
        delete process.env.CALENDAR_REQUIRE_SERIES_END;
        expect(() => assertSeriesHasEnd([ART_CLASS])).not.toThrow();
    });
    it('refuses when on, and says how to fix it', () => {
        process.env.CALENDAR_REQUIRE_SERIES_END = '1';
        expect(() => assertSeriesHasEnd([ART_CLASS])).toThrow(/no end date.*UNTIL=.*COUNT=/s);
        expect(() => assertSeriesHasEnd(['RRULE:FREQ=WEEKLY;UNTIL=20261113T215959Z'])).not.toThrow();
        expect(() => assertSeriesHasEnd(undefined)).not.toThrow();
    });
});

describe('handlers refuse before any Google call when the switch is on', () => {
    const accounts = new Map([['test', new OAuth2Client()]]);
    const prior = process.env.CALENDAR_REQUIRE_SERIES_END;
    beforeEach(() => {
        CalendarRegistry.resetInstance();
        insert.mockReset();
        process.env.CALENDAR_REQUIRE_SERIES_END = '1';
    });
    afterEach(() => {
        if (prior === undefined) delete process.env.CALENDAR_REQUIRE_SERIES_END;
        else process.env.CALENDAR_REQUIRE_SERIES_END = prior;
    });

    const base = {
        calendarId: 'primary', summary: '🎨 Grace — Bona Bana Art',
        start: '2026-10-07T14:00:00', end: '2026-10-07T15:00:00',
    };

    it('create-event', async () => {
        const h = new CreateEventHandler();
        vi.spyOn(h as any, 'getClientWithAutoSelection').mockResolvedValue(
            { client: new OAuth2Client(), accountId: 'test', calendarId: 'primary' });
        const conflicts = vi.spyOn((h as any).conflictDetectionService, 'checkConflicts');
        await expect(h.runTool({ ...base, recurrence: [ART_CLASS] }, accounts)).rejects.toThrow(/no end date/);
        expect(conflicts).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();
    });

    it('create-events fails only the open-ended one', async () => {
        const h = new CreateEventsHandler();
        vi.spyOn(h as any, 'getClientWithAutoSelection').mockResolvedValue(
            { client: new OAuth2Client(), accountId: 'test', calendarId: 'primary' });
        const res: any = await h.runTool({ calendarId: 'primary', events: [{ ...base, recurrence: [ART_CLASS] }] }, accounts)
            .catch((e: Error) => ({ thrown: e.message }));
        const text = JSON.stringify(res);
        expect(text).toMatch(/no end date/);
        expect(insert).not.toHaveBeenCalled();
    });

    it('update-event that SETS an open-ended recurrence', async () => {
        const h = new UpdateEventHandler();
        vi.spyOn(h as any, 'setupOperation').mockResolvedValue({
            client: new OAuth2Client(), calendar: { events: { get: vi.fn(), patch: vi.fn() } },
            accountId: 'test', calendarId: 'primary',
        });
        await expect(h.runTool({ calendarId: 'primary', eventId: 'abc', recurrence: [ART_CLASS] }, accounts))
            .rejects.toThrow(/no end date/);
    });

    it('update-event that does not touch recurrence is not held to it', async () => {
        const h = new UpdateEventHandler();
        vi.spyOn(h as any, 'setupOperation').mockResolvedValue({
            client: new OAuth2Client(), calendar: { events: { get: vi.fn(), patch: vi.fn() } },
            accountId: 'test', calendarId: 'primary',
        });
        await expect(h.runTool({ calendarId: 'primary', eventId: 'abc', summary: 'x' }, accounts))
            .rejects.not.toThrow(/no end date/);
    });
});
