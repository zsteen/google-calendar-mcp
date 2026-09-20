/**
 * thisAndFollowing: what the new series keeps, and the series it may not split.
 *
 * The split INSERTS `{...original, ...requestBody}`, and the envelope guarantees
 * `requestBody.extendedProperties` exists - so the original's private map was
 * replaced wholesale. And on a series linked to kb-school the split fights the
 * pause/cancel reconciler, which owns that recurrence and would undo the UNTIL
 * within minutes, leaving two series running.
 *
 * Runs against the REAL RecurringEventHelpers, like the envelope tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { UpdateEventHandler } from '../../../handlers/core/UpdateEventHandler.js';
import { RECURRING_EVENT_ERRORS } from '../../../handlers/core/RecurringEventHelpers.js';
import { carrySplitSeriesProperties, linkedSeriesRefusal } from '../../../handlers/core/seriesSplit.js';
import { CalendarRegistry } from '../../../services/CalendarRegistry.js';

vi.mock('../../../utils/write-allowlist.js', () => ({ assertWritable: vi.fn() }));
vi.mock('../../../handlers/core/tripFeedStamp.js', async (orig) => ({
    ...(await orig<typeof import('../../../handlers/core/tripFeedStamp.js')>()),
    pokeTripFeed: vi.fn(),
}));

const SERIES = {
    id: 'series',
    summary: 'Eva - MCC 5s Hockey Training',
    location: 'Morningside Country Club, 1 De La Rey Rd',
    start: { dateTime: '2099-10-06T17:00:00+02:00', timeZone: 'Africa/Johannesburg' },
    end: { dateTime: '2099-10-06T18:15:00+02:00', timeZone: 'Africa/Johannesburg' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
    extendedProperties: {
        private: {
            claudia: '1',
            claudia_schema: '2',
            claudia_source: 'gmail:1a0a6b82bef7b2e1',
            claudia_natural_key: 'gmail:1a0a6b82bef7b2e1||2099-10-06|eva-mcc-5s-hockey-training',
            claudia_key_version: 'key_v1',
            claudia_content_hash: 'sha256:abc',
            claudia_loc_policy: 'resolved',
            claudia_loc_confidence: 'high',
            claudia_loc_source: 'venue_kb',
            claudia_venue_id: 'morningside-cc',
            claudia_time_precision: 'placeholder',
            trip_id: 'trip_42',
        },
    },
};

describe('thisAndFollowing split', () => {
    let handler: UpdateEventHandler;
    let calendar: any;
    const accounts = new Map([['test', new OAuth2Client()]]);
    const split = (extra: Record<string, unknown> = {}) => handler.runTool({
        calendarId: 'primary', eventId: 'series', checkConflicts: false,
        modificationScope: 'thisAndFollowing', futureStartDate: '2099-11-03T17:00:00+02:00',
        ...extra,
    }, accounts);
    const inserted = () => calendar.events.insert.mock.calls.at(-1)[0].requestBody;

    beforeEach(() => {
        CalendarRegistry.resetInstance();
        process.env.CLAUDIA_VENUES_PATH = '/nonexistent/known-venues.yml';
        handler = new UpdateEventHandler();
        calendar = {
            events: { patch: vi.fn(), get: vi.fn(), insert: vi.fn() },
            calendars: { get: vi.fn() },
        };
        vi.spyOn(handler as any, 'getCalendar').mockReturnValue(calendar);
        vi.spyOn(handler as any, 'getCalendarTimezone').mockResolvedValue('Africa/Johannesburg');
        vi.spyOn(handler as any, 'getClientWithAutoSelection').mockResolvedValue({
            client: accounts.get('test'), accountId: 'test', calendarId: 'primary', wasAutoSelected: true,
        });
        calendar.events.get.mockResolvedValue({ data: SERIES });
        calendar.events.patch.mockResolvedValue({ data: SERIES });
        calendar.events.insert.mockResolvedValue({ data: { ...SERIES, id: 'new-series' } });
    });

    it('the new series keeps its origin, classification and trip - and never the key', async () => {
        await split({ summary: 'Eva - MCC 5s Hockey Training (new coach)' });
        const priv = inserted().extendedProperties.private;
        expect(priv.claudia_source).toBe('gmail:1a0a6b82bef7b2e1');
        expect(priv.claudia_loc_policy).toBe('resolved');
        expect(priv.claudia_loc_confidence).toBe('high');
        expect(priv.claudia_venue_id).toBe('morningside-cc');
        expect(priv.trip_id).toBe('trip_42');
        expect(priv.claudia).toBe('1');
        expect(priv.claudia_time_precision).toBe('placeholder');     // no new time was given
        // A key names ONE row. Two rows under one key, and the next ingest
        // patches or reconciles the wrong one.
        for (const k of ['claudia_natural_key', 'claudia_key_version', 'claudia_content_hash']) {
            expect(priv[k]).toBeUndefined();
        }
    });

    it('a new time is no longer a placeholder the caller never mentioned', async () => {
        await split({ start: '2099-11-03T16:00:00', end: '2099-11-03T17:15:00' });
        expect(inserted().extendedProperties.private.claudia_time_precision).toBeUndefined();
    });

    it('a split that MOVES the series is honestly unclassified', async () => {
        await split({ location: 'Some Other Club, 9 Unknown Rd' });
        const priv = inserted().extendedProperties.private;
        expect(priv.claudia_loc_policy).toBe('unclassified');
        expect(priv.claudia_source).toBe('gmail:1a0a6b82bef7b2e1');
    });

    it('a series linked to kb-school is REFUSED before anything is written', async () => {
        calendar.events.get.mockResolvedValue({
            data: { ...SERIES, extendedProperties: { private: {
                ...SERIES.extendedProperties.private, kb_school_id: 'wda_0123ba51a2654d78' } } },
        });
        await expect(split({ summary: 'x' })).rejects.toMatchObject({
            code: RECURRING_EVENT_ERRORS.LINKED_SERIES_SPLIT,
        });
        await expect(split({ summary: 'x' })).rejects.toThrow(/kb-school.*reconciler/s);
        // The order is the point: refusing AFTER the UNTIL patch would leave the
        // series truncated with nothing following it.
        expect(calendar.events.patch).not.toHaveBeenCalled();
        expect(calendar.events.insert).not.toHaveBeenCalled();
    });

    it('the same linked series can still be changed whole, or one instance at a time', async () => {
        // The control: the refusal is about the SPLIT, not about the link.
        calendar.events.get.mockResolvedValue({
            data: { ...SERIES, extendedProperties: { private: {
                ...SERIES.extendedProperties.private, kb_school_id: 'wda_0123ba51a2654d78' } } },
        });
        await handler.runTool({
            calendarId: 'primary', eventId: 'series', checkConflicts: false,
            modificationScope: 'all', summary: 'Eva - MCC 5s Hockey Training (renamed)',
        }, accounts);
        expect(calendar.events.patch).toHaveBeenCalledTimes(1);
    });
});

describe('seriesSplit rules', () => {
    it('no link, no refusal', () => {
        expect(linkedSeriesRefusal(SERIES)).toBeNull();
        expect(linkedSeriesRefusal(null)).toBeNull();
        expect(linkedSeriesRefusal({ extendedProperties: { private: { kb_school_id: '  ' } } })).toBeNull();
    });

    it('carrying is fill-if-absent and never invents', () => {
        const body: any = { extendedProperties: { private: { trip_id: 'trip_new' } } };
        carrySplitSeriesProperties(body, SERIES, { timeChanged: false });
        expect(body.extendedProperties.private.trip_id).toBe('trip_new');        // the caller's own wins
        expect(body.extendedProperties.private.claudia_natural_key).toBeUndefined();
        const bare: any = {};
        carrySplitSeriesProperties(bare, { summary: 'no properties' }, { timeChanged: false });
        expect(bare.extendedProperties.private).toEqual({});
    });
});
