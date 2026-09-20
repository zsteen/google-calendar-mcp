/**
 * update-event never replaces what the row already knows with a default.
 *
 * Found 2026-09-19 on live rows: the agent gave the two 'Mercy' performances a
 * start time, and the patch turned `term-doc:redhill-2026-t3 / resolved / high`
 * into `calendar-mcp / unclassified / n/a`. The envelope was filled against the
 * request body - which starts empty on an update - so every field the caller
 * did not mention carried the default, and PATCH wrote it over the row.
 *
 * The RULE is pinned by the shared vectors (calendarEnvelope.test.ts). These
 * tests pin the WIRING, against the REAL RecurringEventHelpers: the sibling
 * UpdateEventHandler tests mock `buildUpdateRequestBody` wholesale, which is
 * exactly where this defect lived and why they never saw it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { UpdateEventHandler } from '../../../handlers/core/UpdateEventHandler.js';
import { CalendarRegistry } from '../../../services/CalendarRegistry.js';

vi.mock('../../../utils/write-allowlist.js', () => ({ assertWritable: vi.fn() }));
// The real one spawns the Trip Feed; nothing here is about that.
vi.mock('../../../handlers/core/tripFeedStamp.js', async (orig) => ({
    ...(await orig<typeof import('../../../handlers/core/tripFeedStamp.js')>()),
    pokeTripFeed: vi.fn(),
}));

const MERCY = {
    id: 'mercy',
    summary: "Production 'Mercy' - Performance 1 - Eva",
    location: 'Redhill School, 20 Summit Rd, Morningside, Sandton',
    start: { date: '2026-10-29' },
    end: { date: '2026-10-30' },
    extendedProperties: {
        private: {
            claudia: '1',
            claudia_schema: '2',
            claudia_source: 'term-doc:redhill-2026-t3',
            claudia_natural_key: 'term-doc:redhill-2026-t3||2026-10-29|middle-school-production-mercy',
            claudia_loc_policy: 'resolved',
            claudia_loc_confidence: 'high',
            claudia_loc_source: 'venue_kb',
            claudia_venue_id: 'redhill-summit',
            claudia_venue_kind: 'campus_sub_venue',
        },
    },
};

describe('update-event keeps the stored envelope', () => {
    let handler: UpdateEventHandler;
    let calendar: any;
    const accounts = new Map([['test', new OAuth2Client()]]);

    const sentPrivate = () =>
        calendar.events.patch.mock.calls.at(-1)[0].requestBody.extendedProperties.private;

    beforeEach(() => {
        CalendarRegistry.resetInstance();
        // No venue KB: these rows are ones the classifier makes no claim on.
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
        calendar.events.get.mockResolvedValue({ data: MERCY });
        calendar.events.patch.mockResolvedValue({ data: { ...MERCY, start: { dateTime: 'x' } } });
    });

    it('a start time on a school-document row leaves its source and classification alone', async () => {
        await handler.runTool({
            calendarId: 'primary', eventId: 'mercy', checkConflicts: false,
            start: '2026-10-29T18:00:00', end: '2026-10-29T20:00:00',
        }, accounts);

        const priv = sentPrivate();
        expect(priv.claudia_source).toBe('term-doc:redhill-2026-t3');
        expect(priv.claudia_loc_policy).toBe('resolved');
        expect(priv.claudia_loc_confidence).toBe('high');
        expect(priv.claudia_schema).toBe('2');
        // PATCH merges per key, so what is NOT sent survives: the body must not
        // carry a second natural key, only the fields it has a say on.
        expect(priv.claudia_natural_key).toBeUndefined();
    });

    it('moving the event somewhere nobody has placed is honestly unclassified', async () => {
        // The control. Kept `resolved` here, the rule would be vouching for a
        // venue nobody looked up - the claim D2 exists to stop.
        await handler.runTool({
            calendarId: 'primary', eventId: 'mercy', checkConflicts: false,
            location: 'Some Hall, 1 Unknown Rd',
        }, accounts);

        const priv = sentPrivate();
        expect(priv.claudia_loc_policy).toBe('unclassified');
        expect(priv.claudia_loc_confidence).toBe('n/a');
        expect(priv.claudia_source).toBe('term-doc:redhill-2026-t3');   // provenance still holds
    });

    it('one instance of a series is read by ITS id, not the master', async () => {
        calendar.events.get.mockImplementation(async ({ eventId }: any) => ({
            data: eventId === 'mercy'
                ? { ...MERCY, recurrence: ['RRULE:FREQ=WEEKLY'] }
                : { ...MERCY, id: eventId, recurringEventId: 'mercy' },
        }));
        await handler.runTool({
            calendarId: 'primary', eventId: 'mercy', checkConflicts: false,
            modificationScope: 'thisEventOnly', originalStartTime: '2026-10-29T18:00:00+02:00',
            summary: 'Performance 1 (moved)',
        }, accounts);

        const patched = calendar.events.patch.mock.calls.at(-1)[0];
        expect(patched.eventId).not.toBe('mercy');
        expect(calendar.events.get).toHaveBeenCalledWith({ calendarId: 'primary', eventId: patched.eventId });
        expect(sentPrivate().claudia_source).toBe('term-doc:redhill-2026-t3');
    });

    it('a row that cannot be read is not written over blind', async () => {
        calendar.events.get
            .mockResolvedValueOnce({ data: MERCY })                 // detectEventType (scope guard)
            .mockResolvedValueOnce({ data: MERCY })                 // detectEventType (updateEventWithScope)
            .mockRejectedValueOnce(new Error('backend error'));     // the stored-row read
        await expect(handler.runTool({
            calendarId: 'primary', eventId: 'mercy', checkConflicts: false, summary: 'x',
        }, accounts)).rejects.toThrow();
        expect(calendar.events.patch).not.toHaveBeenCalled();
    });
});
