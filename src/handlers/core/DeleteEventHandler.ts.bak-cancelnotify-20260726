import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { BaseToolHandler } from "./BaseToolHandler.js";
import { DeleteEventInput } from "../../tools/registry.js";
import { DeleteEventResponse } from "../../types/structured-responses.js";
import { createStructuredResponse } from "../../utils/response-builder.js";
import { RecurringEventHelpers } from './RecurringEventHelpers.js';
import { assertWritable } from "../../utils/write-allowlist.js";

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

        // Phase 7f: hardcode sendUpdates to 'none'.
        args.sendUpdates = 'none';

        // Phase 7f structured audit log.
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
