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

        // Phase 7f: refuse delete on a recurring event without explicit scope,
        // and dispatch on the scope value when supplied.
        // - 'all'           → delete the parent eventId (Google's default behaviour)
        // - 'thisEventOnly' → compute the instance ID from parent + originalStartTime
        //                     and delete that instance only
        // - undefined for a recurring event → REFUSE
        // - undefined for a single event    → fine, single delete
        const argScope = (validArgs as any).modificationScope as 'thisEventOnly' | 'all' | undefined;
        const argOriginalStartTime = (validArgs as any).originalStartTime as string | undefined;

        const calendar = this.getCalendar(oauth2Client);
        const helpers = new RecurringEventHelpers(calendar);
        const eventType = await helpers.detectEventType(validArgs.eventId, resolvedCalendarId);

        if (eventType === 'recurring' && !argScope) {
            throw new Error(
                `delete-event on a recurring event requires explicit modificationScope. ` +
                `Accepted values: thisEventOnly, all. ` +
                `For thisEventOnly, also pass originalStartTime (ISO 8601 of the occurrence).`
            );
        }

        if (argScope === 'thisEventOnly' && !argOriginalStartTime) {
            throw new Error(
                `delete-event with modificationScope='thisEventOnly' requires originalStartTime ` +
                `(ISO 8601 timestamp of the specific occurrence to delete).`
            );
        }

        // Resolve which event ID we actually delete.
        let targetEventId = validArgs.eventId;
        if (eventType === 'recurring' && argScope === 'thisEventOnly') {
            targetEventId = helpers.formatInstanceId(validArgs.eventId, argOriginalStartTime!);
        }

        // Phase 7f: hardcode sendUpdates to 'none'.
        args.sendUpdates = 'none';

        // Phase 7f structured audit log.
        process.stderr.write(JSON.stringify({
            event: 'write_attempt',
            tool: 'delete-event',
            calendarId: resolvedCalendarId,
            account: selectedAccountId,
            eventType,
            modificationScope: argScope ?? null,
            targetEventId,
            ts: new Date().toISOString(),
        }) + '\n');

        // Delete the event with resolved calendar ID + resolved target event ID.
        await this.deleteEvent(oauth2Client, {
            ...validArgs,
            calendarId: resolvedCalendarId,
            eventId: targetEventId,
        });

        const response: DeleteEventResponse = {
            success: true,
            eventId: targetEventId,
            calendarId: resolvedCalendarId,
            message: argScope === 'thisEventOnly'
                ? "Single occurrence deleted; rest of the series intact."
                : eventType === 'recurring'
                    ? "Entire recurring series deleted."
                    : "Event deleted successfully",
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
