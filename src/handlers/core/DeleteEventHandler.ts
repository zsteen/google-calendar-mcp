import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { BaseToolHandler } from "./BaseToolHandler.js";
import { DeleteEventInput } from "../../tools/registry.js";
import { DeleteEventResponse } from "../../types/structured-responses.js";
import { createStructuredResponse } from "../../utils/response-builder.js";
import { RecurringEventHelpers } from './RecurringEventHelpers.js';
import { assertWritable } from "../../utils/write-allowlist.js";
import { resolveSendUpdates } from "../../utils/invite-allowlist.js";

// A real undo happens seconds after the create; 2x the 60s undo window used elsewhere
// (phase-11b DEFAULT_UNDO_WINDOW_SECONDS) to allow for confirm latency.
const DELETE_UNDO_WINDOW_SECONDS = 120;

export class DeleteEventHandler extends BaseToolHandler {
    async runTool(args: any, accounts: Map<string, OAuth2Client>): Promise<CallToolResult> {
        const validArgs = args as DeleteEventInput;

        // Get OAuth2Client with automatic account selection for write operations
        // Also resolves calendar name to ID if a name was provided
        const { client: oauth2Client, accountId: selectedAccountId, calendarId: resolvedCalendarId } = await this.getClientWithAutoSelection(
            args.account,
            validArgs.calendarId,
            accounts,
            'write'
        );

        // Phase 7f write allowlist — see PHASE-7F-SPEC.md §3 Patch B.
        assertWritable(resolvedCalendarId);

        const argScope = (validArgs as any).modificationScope as 'thisEventOnly' | 'all' | undefined;
        const argOriginalStartTime = (validArgs as any).originalStartTime as string | undefined;

        // Phase 7f: fetch the event to learn whether the passed eventId is a
        // recurring parent, an already-formatted instance, or a single event.
        // We can't naively re-apply formatInstanceId — agents commonly pass the
        // instance ID directly (especially after seeing it in a list-events
        // response), and double-formatting yields `parentId_xxx_xxx` which
        // Google 404s.
        const calendar = this.getCalendar(oauth2Client);
        const existing = await calendar.events.get({
            calendarId: resolvedCalendarId,
            eventId: validArgs.eventId,
        });
        const event = existing.data;
        const isParentSeries = !!(event.recurrence && event.recurrence.length > 0);
        const isInstance = !!event.recurringEventId;
        const isRecurringContext = isParentSeries || isInstance;

        if (isRecurringContext && !argScope) {
            throw new Error(
                `delete-event on a recurring event requires explicit modificationScope. ` +
                `Accepted values: thisEventOnly, all. ` +
                `For thisEventOnly with a parent-series eventId, also pass originalStartTime ` +
                `(ISO 8601 of the occurrence to delete). For thisEventOnly with an instance ` +
                `eventId, originalStartTime is unnecessary — the instance ID already addresses ` +
                `the specific occurrence.`
            );
        }

        // Resolve the actual eventId to send to Google.
        let targetEventId = validArgs.eventId;
        let resolution: 'single' | 'instance-direct' | 'instance-via-format' | 'parent-series' | 'series-from-instance' = 'single';

        if (!isRecurringContext) {
            // Single event — just delete by passed ID. Scope (if any) is ignored.
            resolution = 'single';
        } else if (isInstance) {
            // eventId already addresses an instance.
            if (argScope === 'thisEventOnly') {
                targetEventId = validArgs.eventId;
                resolution = 'instance-direct';
            } else {
                // scope='all' with an instance ID → resolve to the parent and delete that.
                targetEventId = event.recurringEventId!;
                resolution = 'series-from-instance';
            }
        } else if (isParentSeries) {
            if (argScope === 'thisEventOnly') {
                if (!argOriginalStartTime) {
                    throw new Error(
                        `delete-event with modificationScope='thisEventOnly' on a parent-series ` +
                        `eventId requires originalStartTime (ISO 8601 of the specific occurrence ` +
                        `to delete). Alternatively, pass the instance eventId directly and the ` +
                        `MCP will delete that instance without originalStartTime.`
                    );
                }
                const helpers = new RecurringEventHelpers(calendar);
                targetEventId = helpers.formatInstanceId(validArgs.eventId, argOriginalStartTime);
                resolution = 'instance-via-format';
            } else {
                // scope='all' on parent — delete the whole series.
                targetEventId = validArgs.eventId;
                resolution = 'parent-series';
            }
        }

        // Cancellation notifications (2026-07-26): notify guests on a genuine
        // cancel, but ONLY through the same invite-allowlist gate that create/
        // update use — Google is emailed 'all' only when EVERY attendee is
        // Invite-approved, else 'none' (never email an off-list address). An
        // explicit sendUpdates='none' is always honoured, so the undo-window
        // flow (which passes 'none') stays silent even for an allowlisted guest.
        // Supersedes the earlier Phase 7f blanket 'none' hardcode.
        // TIGHTENED 2026-08-04. An explicit sendUpdates='none' is honoured ONLY for a genuine
        // UNDO — an event created moments ago (AGENTS.md's undo block deletes a just-made save
        // with sendUpdates='none'). Outside that window the allowlist wins and the caller's
        // 'none' is overridden.
        //
        // Why: Zig cancelled Eva's hockey match. Claudia passed sendUpdates='none', generalising
        // the undo instruction to a real cancellation, which short-circuited the allowlist. The
        // event vanished from Google but the guests -- Zig's RMB work calendar AND Bruce, both
        // Invite-approved -- were never told, so they kept a stale commitment. The "hard control"
        // the docs advertise was not one: any caller could silence it.
        // Proven by two audit lines minutes apart: sendUpdates 'all' (manual) delivered the
        // cancellation; sendUpdates 'none' (Claudia) did not.
        const createdMs = event.created ? Date.parse(event.created) : NaN;
        const withinUndoWindow = Number.isFinite(createdMs)
            && (Date.now() - createdMs) <= DELETE_UNDO_WINDOW_SECONDS * 1000;
        const r = resolveSendUpdates(event.attendees);
        let notifySkipped: string[] = r.skipped;
        let notifyOverride: string | null = null;
        if (validArgs.sendUpdates === 'none' && withinUndoWindow) {
            args.sendUpdates = 'none';
            notifyOverride = 'undo_window';
        } else if (validArgs.sendUpdates === 'none' && r.sendUpdates === 'all') {
            args.sendUpdates = 'all';
            notifyOverride = 'caller_none_overridden_outside_undo_window';
        } else if (validArgs.sendUpdates === 'none') {
            args.sendUpdates = 'none';
        } else {
            args.sendUpdates = r.sendUpdates;
        }

        // Structured audit log (extends the Phase 7f write-attempt record).
        process.stderr.write(JSON.stringify({
            event: 'write_attempt',
            tool: 'delete-event',
            calendarId: resolvedCalendarId,
            account: selectedAccountId,
            eventType: isRecurringContext ? 'recurring' : 'single',
            isParentSeries,
            isInstance,
            modificationScope: argScope ?? null,
            resolution,
            inputEventId: validArgs.eventId,
            targetEventId,
            sendUpdates: args.sendUpdates,
            notifySkipped,
            notifyOverride,
            ts: new Date().toISOString(),
        }) + '\n');

        // Delete using the resolved target.
        await this.deleteEvent(oauth2Client, {
            ...validArgs,
            calendarId: resolvedCalendarId,
            eventId: targetEventId,
        });

        let message: string;
        switch (resolution) {
            case 'instance-direct':
            case 'instance-via-format':
                message = 'Single occurrence deleted; rest of the series intact.';
                break;
            case 'parent-series':
            case 'series-from-instance':
                message = 'Entire recurring series deleted.';
                break;
            default:
                message = 'Event deleted successfully';
        }

        const response: DeleteEventResponse = {
            success: true,
            eventId: targetEventId,
            calendarId: resolvedCalendarId,
            message,
        };

        return createStructuredResponse(response);
    }

    private async deleteEvent(
        client: OAuth2Client,
        args: DeleteEventInput,
    ): Promise<void> {
        try {
            const calendar = this.getCalendar(client);
            await calendar.events.delete({
                calendarId: args.calendarId,
                eventId: args.eventId,
                sendUpdates: args.sendUpdates,
            });
        } catch (error) {
            throw this.handleGoogleApiError(error);
        }
    }
}
