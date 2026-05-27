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

        // Phase 7f: refuse delete on a recurring event without explicit scope.
        // events.delete with a recurring-parent eventId silently deletes the
        // entire series — same hazard as UpdateEventHandler's silent-mutate.
        // DeleteEventInput's schema does not expose modificationScope today;
        // read it defensively off args in case the schema is extended later,
        // otherwise refuse on any recurring event.
        const argScope = (args as any).modificationScope as string | undefined;
        if (!argScope) {
            const calendar = this.getCalendar(oauth2Client);
            const helpers = new RecurringEventHelpers(calendar);
            const eventType = await helpers.detectEventType(validArgs.eventId, resolvedCalendarId);
            if (eventType === 'recurring') {
                throw new Error(
                    `delete-event on a recurring event requires explicit modificationScope. ` +
                    `Accepted values: thisEventOnly, thisAndFollowing, all. ` +
                    `For thisEventOnly, pass the instance event ID (e.g. parentId_YYYYMMDDTHHMMSSZ).`
                );
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
            modificationScope: argScope ?? null,
            ts: new Date().toISOString(),
        }) + '\n');

        // Delete the event with resolved calendar ID
        const argsWithResolvedCalendar = { ...validArgs, calendarId: resolvedCalendarId };
        await this.deleteEvent(oauth2Client, argsWithResolvedCalendar);

        const response: DeleteEventResponse = {
            success: true,
            eventId: validArgs.eventId,
            calendarId: resolvedCalendarId,
            message: "Event deleted successfully"
        };

        return createStructuredResponse(response);
    }

    private async deleteEvent(
        client: OAuth2Client,
        args: DeleteEventInput
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
