import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeleteEventHandler } from '../../../handlers/core/DeleteEventHandler.js';
import { OAuth2Client } from 'google-auth-library';
import { CalendarRegistry } from '../../../services/CalendarRegistry.js';
import { _resetCacheForTests } from '../../../utils/invite-allowlist.js';

// Phase 7f: mock the write-allowlist as a no-op; refusal-path coverage lives in
// src/tests/unit/utils/write-allowlist.test.ts.
vi.mock('../../../utils/write-allowlist.js', () => ({
  assertWritable: vi.fn(),
}));

// Phase 7f: mock RecurringEventHelpers — the new delete-on-recurring guard
// instantiates this. Default: report non-recurring so the existing tests
// (which delete primary, non-recurring events) don't trip the scope refusal.
vi.mock('../../../handlers/core/RecurringEventHelpers.js', () => ({
  RecurringEventHelpers: class {
    detectEventType = vi.fn().mockResolvedValue('single');
    constructor(_calendar: any) {}
  },
}));

// Mock the googleapis module
vi.mock('googleapis', () => ({
  google: {
    calendar: vi.fn(() => ({
      events: {
        delete: vi.fn(),
        get: vi.fn()
      }
    }))
  },
  calendar_v3: {}
}));

describe('DeleteEventHandler', () => {
  let handler: DeleteEventHandler;
  let mockOAuth2Client: OAuth2Client;
  let mockAccounts: Map<string, OAuth2Client>;
  let mockCalendar: any;

  beforeEach(() => {
    // Reset the singleton to get a fresh instance for each test
    CalendarRegistry.resetInstance();

    handler = new DeleteEventHandler();
    mockOAuth2Client = new OAuth2Client();
    mockAccounts = new Map([['test', mockOAuth2Client]]);

    // Setup mock calendar
    mockCalendar = {
      events: {
        delete: vi.fn(),
        // Phase 7f: handler now calls events.get to learn the event shape
        // (parent series vs instance vs single) before dispatching.
        // Default to a single event so the existing tests stay green.
        get: vi.fn().mockResolvedValue({ data: { id: 'event123' } })
      }
    };

    // Mock the getCalendar method
    vi.spyOn(handler as any, 'getCalendar').mockReturnValue(mockCalendar);

    // Mock getClientWithAutoSelection to return the test account
    vi.spyOn(handler as any, 'getClientWithAutoSelection').mockResolvedValue({
      client: mockOAuth2Client,
      accountId: 'test',
      calendarId: 'primary',
      wasAutoSelected: true
    });
  });

  describe('Basic Event Deletion', () => {
    it('should delete an event successfully', async () => {
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      const args = {
        calendarId: 'primary',
        eventId: 'event123'
      };

      const result = await handler.runTool(args, mockAccounts);

      // No attendees on the fetched event → allowlist gate resolves to 'none'.
      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'none'
      });

      expect(result.content[0].type).toBe('text');
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
      expect(response.eventId).toBe('event123');
      expect(response.calendarId).toBe('primary');
      expect(response.message).toBe('Event deleted successfully');
    });

    it('should delete event with explicit account parameter', async () => {
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      const args = {
        calendarId: 'primary',
        eventId: 'event123',
        account: 'test'
      };

      const result = await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalled();
      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(true);
    });
  });

  describe('Send Updates Options (no allowlisted guests → none)', () => {
    it('resolves to none when input is all but the event has no attendees', async () => {
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      const args = {
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'all'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'none'
      });
    });

    it('resolves to none when input is externalOnly but the event has no attendees', async () => {
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      const args = {
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'externalOnly'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'none'
      });
    });

    it('keeps sendUpdates as none when input is none', async () => {
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      const args = {
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'none'
      };

      await handler.runTool(args, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'none'
      });
    });
  });

  describe('Cancellation notifications (allowlist-gated)', () => {
    let allowlistFile: string;

    beforeEach(() => {
      // Real temp allowlist so resolveSendUpdates() has a file to read.
      allowlistFile = path.join(os.tmpdir(), `del-invite-allowlist-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(allowlistFile, 'guest@allowed.com\nsecond@allowed.com\n');
      process.env.CALENDAR_INVITE_ALLOWLIST_PATH = allowlistFile;
      _resetCacheForTests();
    });

    afterEach(() => {
      delete process.env.CALENDAR_INVITE_ALLOWLIST_PATH;
      _resetCacheForTests();
      try { fs.unlinkSync(allowlistFile); } catch { /* ignore */ }
    });

    it("notifies ('all') when every attendee is on the invite allowlist", async () => {
      mockCalendar.events.get.mockResolvedValue({
        data: { id: 'event123', attendees: [{ email: 'guest@allowed.com' }, { email: 'Second@Allowed.com' }] }
      });
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      await handler.runTool({ calendarId: 'primary', eventId: 'event123' }, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'all'
      });
    });

    it("stays silent ('none') when any attendee is off the allowlist", async () => {
      mockCalendar.events.get.mockResolvedValue({
        data: { id: 'event123', attendees: [{ email: 'guest@allowed.com' }, { email: 'stranger@offlist.com' }] }
      });
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      await handler.runTool({ calendarId: 'primary', eventId: 'event123' }, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'none'
      });
    });

    // A caller-supplied 'none' is an exception for ONE case: undo of a save nobody
    // has seen yet. Before 2026-08-04 it was honoured unconditionally, which meant a
    // genuine cancellation notified nobody. These three tests pin the narrowed rule.
    it("honors explicit sendUpdates='none' INSIDE the 120s undo window (undo stays silent)", async () => {
      mockCalendar.events.get.mockResolvedValue({
        data: {
          id: 'event123',
          attendees: [{ email: 'guest@allowed.com' }],
          created: new Date().toISOString()   // just created -> this IS an undo
        }
      });
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      await handler.runTool({ calendarId: 'primary', eventId: 'event123', sendUpdates: 'none' }, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'none'
      });
    });

    it("OVERRIDES explicit sendUpdates='none' outside the undo window (a real cancellation must reach guests)", async () => {
      mockCalendar.events.get.mockResolvedValue({
        data: {
          id: 'event123',
          attendees: [{ email: 'guest@allowed.com' }],
          created: new Date(Date.now() - 10 * 60 * 1000).toISOString()  // 10 min old
        }
      });
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      await handler.runTool({ calendarId: 'primary', eventId: 'event123', sendUpdates: 'none' }, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'all'
      });
    });

    it("OVERRIDES explicit sendUpdates='none' when the event has no created timestamp (fail-safe: notify)", async () => {
      mockCalendar.events.get.mockResolvedValue({
        data: { id: 'event123', attendees: [{ email: 'guest@allowed.com' }] }  // no `created`
      });
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      await handler.runTool({ calendarId: 'primary', eventId: 'event123', sendUpdates: 'none' }, mockAccounts);

      expect(mockCalendar.events.delete).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'event123',
        sendUpdates: 'all'
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle event not found error', async () => {
      const apiError = new Error('Not Found');
      (apiError as any).code = 404;
      mockCalendar.events.delete.mockRejectedValue(apiError);

      const args = {
        calendarId: 'primary',
        eventId: 'nonexistent'
      };

      // Mock handleGoogleApiError to throw a specific error
      vi.spyOn(handler as any, 'handleGoogleApiError').mockImplementation(() => {
        throw new Error('Event not found');
      });

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow('Event not found');
    });

    it('should handle permission denied error', async () => {
      const apiError = new Error('Forbidden');
      (apiError as any).code = 403;
      mockCalendar.events.delete.mockRejectedValue(apiError);

      const args = {
        calendarId: 'primary',
        eventId: 'event123'
      };

      // Mock handleGoogleApiError to throw a specific error
      vi.spyOn(handler as any, 'handleGoogleApiError').mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow('Permission denied');
    });

    it('should handle API errors', async () => {
      const apiError = new Error('Bad Request');
      (apiError as any).code = 400;
      mockCalendar.events.delete.mockRejectedValue(apiError);

      const args = {
        calendarId: 'primary',
        eventId: 'event123'
      };

      // Mock handleGoogleApiError to throw a specific error
      vi.spyOn(handler as any, 'handleGoogleApiError').mockImplementation(() => {
        throw new Error('Bad Request');
      });

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow('Bad Request');
    });
  });

  describe('Multi-Account Handling', () => {
    it('should throw error when no account has write access', async () => {
      // Override the default mock to reject with access error
      vi.spyOn(handler as any, 'getClientWithAutoSelection').mockRejectedValue(
        new Error('No account has write access to calendar "primary"')
      );

      const args = {
        calendarId: 'primary',
        eventId: 'event123'
      };

      await expect(handler.runTool(args, mockAccounts)).rejects.toThrow(
        'No account has write access to calendar "primary"'
      );
    });

    it('should use specified account when provided', async () => {
      // Verify getClientWithAutoSelection is called with the account parameter
      const spy = vi.spyOn(handler as any, 'getClientWithAutoSelection').mockResolvedValue({
        client: mockOAuth2Client,
        accountId: 'test',
        calendarId: 'primary',
        wasAutoSelected: false
      });
      mockCalendar.events.delete.mockResolvedValue({ data: {} });

      const args = {
        calendarId: 'primary',
        eventId: 'event123',
        account: 'test'
      };

      await handler.runTool(args, mockAccounts);

      // Verify the account was passed to getClientWithAutoSelection
      expect(spy).toHaveBeenCalledWith('test', 'primary', mockAccounts, 'write');
    });
  });
});
