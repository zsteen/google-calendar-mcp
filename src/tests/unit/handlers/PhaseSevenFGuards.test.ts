import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateEventHandler } from '../../../handlers/core/UpdateEventHandler.js';
import { DeleteEventHandler } from '../../../handlers/core/DeleteEventHandler.js';
import { OAuth2Client } from 'google-auth-library';
import { CalendarRegistry } from '../../../services/CalendarRegistry.js';

// Phase 7f-specific tests — AT-7f-9 (recurring-event scope refusal at the
// handler boundary). The write-allowlist itself is exercised in
// src/tests/unit/utils/write-allowlist.test.ts; here we just need it to be a
// no-op so the recurrence guard is what fires.
vi.mock('../../../utils/write-allowlist.js', () => ({
    assertWritable: vi.fn(),
}));

// Mock googleapis so handler instantiation doesn't try to reach Google.
vi.mock('googleapis', () => ({
    google: {
        calendar: vi.fn(() => ({
            events: {
                patch: vi.fn(),
                get: vi.fn(),
                delete: vi.fn(),
            },
        })),
    },
    calendar_v3: {},
}));

// Override the RecurringEventHelpers mock — these tests need detectEventType
// to return 'recurring'.
vi.mock('../../../handlers/core/RecurringEventHelpers.js', () => ({
    RecurringEventHelpers: class {
        detectEventType = vi.fn().mockResolvedValue('recurring');
        getCalendar = vi.fn();
        buildUpdateRequestBody = vi.fn(() => ({}));
        constructor(_calendar: any) {}
    },
    RecurringEventError: class extends Error {
        code: string;
        constructor(message: string, code: string) {
            super(message);
            this.code = code;
        }
    },
    RECURRING_EVENT_ERRORS: { NON_RECURRING_SCOPE: 'NON_RECURRING_SCOPE' },
}));

describe('Phase 7f — recurring-event scope refusal (AT-7f-9)', () => {
    let mockOAuth2Client: OAuth2Client;
    let mockAccounts: Map<string, OAuth2Client>;

    beforeEach(() => {
        CalendarRegistry.resetInstance();
        mockOAuth2Client = new OAuth2Client();
        mockAccounts = new Map([['test', mockOAuth2Client]]);
    });

    describe('UpdateEventHandler', () => {
        let handler: UpdateEventHandler;

        beforeEach(() => {
            handler = new UpdateEventHandler();
            // setupOperation is a BaseToolHandler helper; stub it so we hit the
            // guard without reaching auth/calendar resolution.
            vi.spyOn(handler as any, 'setupOperation').mockResolvedValue({
                client: mockOAuth2Client,
                calendar: { events: { get: vi.fn(), patch: vi.fn() } },
                accountId: 'test',
                calendarId: 'household@group.calendar.google.com',
            });
        });

        it('refuses when event is recurring and modificationScope is unset', async () => {
            const args = {
                calendarId: 'household@group.calendar.google.com',
                eventId: 'recurring-event-id',
                summary: 'New title',
                // No modificationScope.
            };

            await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
                /requires explicit modificationScope/,
            );
        });

        it('proceeds past the guard when modificationScope is supplied (any value)', async () => {
            const args = {
                calendarId: 'household@group.calendar.google.com',
                eventId: 'recurring-event-id',
                modificationScope: 'thisEventOnly',
                originalStartTime: '2026-06-01T10:00:00',
                summary: 'New title',
            };

            // The guard short-circuits before reaching the (mocked) Google call;
            // we just need to confirm it does NOT throw the scope-required error.
            await expect(handler.runTool(args, mockAccounts)).rejects.not.toThrow(
                /requires explicit modificationScope/,
            );
        });
    });

    describe('DeleteEventHandler', () => {
        let handler: DeleteEventHandler;
        let mockCalendar: any;

        beforeEach(() => {
            handler = new DeleteEventHandler();
            vi.spyOn(handler as any, 'getClientWithAutoSelection').mockResolvedValue({
                client: mockOAuth2Client,
                accountId: 'test',
                calendarId: 'household@group.calendar.google.com',
            });
            // Phase 7f: handler calls events.get to learn the event shape.
            // Tests in this block target a parent recurring series.
            mockCalendar = {
                events: {
                    delete: vi.fn(),
                    get: vi.fn().mockResolvedValue({
                        data: {
                            id: 'recurring-event-id',
                            recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SA'],
                        },
                    }),
                },
            };
            vi.spyOn(handler as any, 'getCalendar').mockReturnValue(mockCalendar);
        });

        it('refuses when event is recurring (parent series) and modificationScope is unset', async () => {
            const args = {
                calendarId: 'household@group.calendar.google.com',
                eventId: 'recurring-event-id',
                // No modificationScope.
            };

            await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
                /requires explicit modificationScope/,
            );
        });

        it('proceeds with scope=all on a parent series and deletes by parent ID', async () => {
            const args = {
                calendarId: 'household@group.calendar.google.com',
                eventId: 'recurring-event-id',
                modificationScope: 'all',
            };

            await expect(handler.runTool(args, mockAccounts)).resolves.toBeDefined();
            expect(mockCalendar.events.delete).toHaveBeenCalledWith(expect.objectContaining({
                eventId: 'recurring-event-id',
            }));
        });

        it('with scope=thisEventOnly and a pre-formatted instance eventId, deletes that instance directly (no double-format)', async () => {
            // Regression for Claudia's AT-7f-12 fail 2026-05-28 — agent passed
            // a computed instance ID as eventId; previous code re-applied
            // formatInstanceId, producing eventId_xxx_xxx and 404.
            mockCalendar.events.get.mockResolvedValueOnce({
                data: {
                    id: 'sfora_20260530T070000Z',
                    recurringEventId: 'sfora',
                    originalStartTime: { dateTime: '2026-05-30T09:00:00', timeZone: 'Africa/Johannesburg' },
                },
            });

            const args = {
                calendarId: 'household@group.calendar.google.com',
                eventId: 'sfora_20260530T070000Z',
                modificationScope: 'thisEventOnly',
                originalStartTime: '2026-05-30T09:00:00+02:00',
            };

            await expect(handler.runTool(args, mockAccounts)).resolves.toBeDefined();
            expect(mockCalendar.events.delete).toHaveBeenCalledWith(expect.objectContaining({
                eventId: 'sfora_20260530T070000Z',
            }));
        });

        it('with scope=all on an instance eventId, resolves to and deletes the parent series', async () => {
            mockCalendar.events.get.mockResolvedValueOnce({
                data: {
                    id: 'sfora_20260530T070000Z',
                    recurringEventId: 'sfora',
                },
            });

            const args = {
                calendarId: 'household@group.calendar.google.com',
                eventId: 'sfora_20260530T070000Z',
                modificationScope: 'all',
            };

            await expect(handler.runTool(args, mockAccounts)).resolves.toBeDefined();
            expect(mockCalendar.events.delete).toHaveBeenCalledWith(expect.objectContaining({
                eventId: 'sfora',
            }));
        });
    });
});
