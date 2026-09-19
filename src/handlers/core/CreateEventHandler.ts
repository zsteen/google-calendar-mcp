import { CallToolResult, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { CreateEventInput } from "../../tools/registry.js";
import { BaseToolHandler } from "./BaseToolHandler.js";
import { calendar_v3 } from 'googleapis';
import { createTimeObject } from "../../utils/datetime.js";
import { validateEventId } from "../../utils/event-id-validator.js";
import { ConflictDetectionService } from "../../services/conflict-detection/index.js";
import { CONFLICT_DETECTION_CONFIG } from "../../services/conflict-detection/config.js";
import { createStructuredResponse, convertConflictsToStructured, createWarningsArray } from "../../utils/response-builder.js";
import { CreateEventResponse, convertGoogleEventToStructured } from "../../types/structured-responses.js";
import { assertWritable } from "../../utils/write-allowlist.js";
import { resolveSendUpdates } from "../../utils/invite-allowlist.js";
import { stampClaudia, pokeTripFeed } from "./tripFeedStamp.js";
import { applyWriteEnvelope } from "./calendarEnvelope.js";
import { classifyLocationAtWrite } from "./venueKb.js";
import { ACTION_ADOPT, ACTION_AMBIGUOUS, ACTION_NOOP, ACTION_PATCH, ACTION_REVIVE, ACTION_SUPPRESSED, contentHash, decideOnConflict, decideOnKeyMatch, deriveIdFromBody, isIdempotentWrite } from "./calendarIdempotency.js";
import { recordRevive, reconciledKeys } from "./calendarReconciliation.js";

export class CreateEventHandler extends BaseToolHandler {
    private conflictDetectionService: ConflictDetectionService;
    
    constructor() {
        super();
        this.conflictDetectionService = new ConflictDetectionService();
    }
    
    async runTool(args: any, accounts: Map<string, OAuth2Client>): Promise<CallToolResult> {
        const validArgs = args as CreateEventInput;

        // Get OAuth2Client with automatic account selection for write operations
        // Also resolves calendar name to ID if a name was provided
        const { client: oauth2Client, accountId: selectedAccountId, calendarId: resolvedCalendarId } = await this.getClientWithAutoSelection(
            args.account,
            validArgs.calendarId,
            accounts,
            'write'
        );

        // Phase 7f write allowlist — refuse any calendar outside the allowlist.
        // Check runs AFTER name resolution so a name resolving to an out-of-allowlist
        // ID is still refused. See PHASE-7F-SPEC.md §3 Patch B.
        assertWritable(resolvedCalendarId);

        // Phase 7f guest-invite (PHASE-7F-GUEST-INVITE-SPEC.md): decide sendUpdates
        // from the invite allowlist instead of a blanket 'none'. 'all' (email every
        // guest) ONLY when every attendee is allowlisted; any off-list attendee =>
        // 'none' (create the event, email nobody) with the addresses in `skipped`.
        // Fail-safe: a missing allowlist file => 'none'. The downstream events.insert
        // call reads args.sendUpdates, so mutating args here applies the decision.
        const { sendUpdates: cSendUpdates, skipped: cSkipped } = resolveSendUpdates(args.attendees);
        args.sendUpdates = cSendUpdates;

        // Phase 7f structured audit log — one JSON line per write attempt.
        // Consumed by Phase 9e for daily summarisation.
        process.stderr.write(JSON.stringify({
            event: 'write_attempt',
            tool: 'create-event',
            calendarId: resolvedCalendarId,
            account: selectedAccountId,
            sendUpdates: cSendUpdates,
            invitesSkipped: cSkipped,
            ts: new Date().toISOString(),
        }) + '\n');

        // Validate primary calendar requirement for outOfOffice and workingLocation events
        if (validArgs.eventType === 'outOfOffice' || validArgs.eventType === 'workingLocation') {
            if (resolvedCalendarId !== 'primary' && !resolvedCalendarId.includes('@')) {
                const eventTypeName = validArgs.eventType === 'outOfOffice' ? 'Out of Office' : 'Working Location';
                throw new Error(
                    `${eventTypeName} events can only be created on the primary calendar. ` +
                    'Use calendarId: "primary" or your email address.'
                );
            }
        }

        // Create the event object for conflict checking
        const timezone = args.timeZone || await this.getCalendarTimezone(oauth2Client, resolvedCalendarId);
        const eventToCheck: calendar_v3.Schema$Event = {
            summary: args.summary,
            description: args.description,
            start: createTimeObject(args.start, timezone),
            end: createTimeObject(args.end, timezone),
            attendees: args.attendees,
            location: args.location,
        };
        
        // Check for conflicts and duplicates using resolved calendar ID
        const conflicts = await this.conflictDetectionService.checkConflicts(
            oauth2Client,
            eventToCheck,
            resolvedCalendarId,
            {
                checkDuplicates: true,
                checkConflicts: true,
                calendarsToCheck: validArgs.calendarsToCheck || [resolvedCalendarId],
                duplicateSimilarityThreshold: validArgs.duplicateSimilarityThreshold || CONFLICT_DETECTION_CONFIG.DEFAULT_DUPLICATE_THRESHOLD
            }
        );

        // Block creation if exact or near-exact duplicate found
        const exactDuplicate = conflicts.duplicates.find(
            dup => dup.event.similarity >= CONFLICT_DETECTION_CONFIG.DUPLICATE_THRESHOLDS.BLOCKING
        );

        // D1 (task 1.10): skip the fuzzy check when the id will be DERIVED.
        //
        // Similarity matching is a fallback for writes whose id the server
        // assigns — it guesses at duplication because nothing else can. Once the
        // id comes from the row, the API enforces uniqueness EXACTLY and the 409
        // branch decides correctly (no-op / converge / suppress). Leaving the
        // guess in front of it is not just redundant: at 95% it fires before the
        // branch can run, so a source document that changes slightly gets its
        // convergence patch BLOCKED and reported as a duplicate instead.
        const idempotent = isIdempotentWrite(validArgs.extendedProperties, validArgs.eventId);

        if (exactDuplicate && !idempotent && validArgs.allowDuplicates !== true) {
            // Throw an error that will be handled by MCP SDK
            throw new Error(
                `Duplicate event detected (${Math.round(exactDuplicate.event.similarity * 100)}% similar). ` +
                `Event "${exactDuplicate.event.title}" already exists. ` +
                `To create anyway, set allowDuplicates to true.`
            );
        }

        // Create the event with resolved calendar ID
        const argsWithResolvedCalendar = { ...validArgs, calendarId: resolvedCalendarId };
        const event = await this.createEvent(oauth2Client, argsWithResolvedCalendar);

        // Generate structured response with conflict warnings
        const structuredConflicts = convertConflictsToStructured(conflicts);
        const warnings = createWarningsArray(conflicts) ?? [];
        // Surface any attendee we did NOT email (off the invite allowlist) so Claudia
        // can tell the user "created, but I did not email X" rather than silently dropping it.
        if (cSkipped.length > 0) {
            warnings.push(
                `Not emailed (not on the invite allowlist): ${cSkipped.join(', ')}. ` +
                `The event was created and these people were added as guests, but no invitation email was sent to them.`
            );
        }
        const response: CreateEventResponse = {
            event: convertGoogleEventToStructured(event, resolvedCalendarId, selectedAccountId),
            conflicts: structuredConflicts.conflicts,
            duplicates: structuredConflicts.duplicates,
            warnings
        };

        return createStructuredResponse(response);
    }

    private async createEvent(
        client: OAuth2Client,
        args: CreateEventInput
    ): Promise<calendar_v3.Schema$Event> {
        let calendarUsed: any = null;
        let derivedIdUsed: string | null = null;
        let desiredHashUsed: string | null = null;
        let bodyUsed: any = null;
        // 3.1d: hoisted like the three above, because the 409 branch in the
        // catch needs it and re-reading the ledger there could see a different
        // file than the pre-insert branch did.
        let naturalKeyUsed: string | null = null;
        let reconciledUsed: Set<string> = new Set();
        try {
            // Hoisted out of the try below: the 409 branch in the catch needs it
            // to read back the event that already exists.
            calendarUsed = this.getCalendar(client);
            const calendar = calendarUsed;
            
            // Validate custom event ID if provided
            if (args.eventId) {
                validateEventId(args.eventId);
            }
            
            // Use provided timezone or calendar's default timezone
            const timezone = args.timeZone || await this.getCalendarTimezone(client, args.calendarId);

            // Determine transparency and visibility based on event type
            const { transparency, visibility } = this.getEventTypeDefaults(args);

            // Generate summary for workingLocation if not provided
            const summary = args.eventType === 'workingLocation' && !args.summary
                ? this.generateWorkingLocationSummary(args)
                : args.summary;

            const requestBody: calendar_v3.Schema$Event = {
                summary: summary,
                description: args.description,
                start: createTimeObject(args.start, timezone),
                end: createTimeObject(args.end, timezone),
                attendees: args.attendees,
                location: args.location,
                colorId: args.colorId,
                reminders: args.reminders,
                recurrence: args.recurrence,
                transparency: transparency,
                visibility: visibility,
                guestsCanInviteOthers: args.guestsCanInviteOthers,
                guestsCanModify: args.guestsCanModify,
                guestsCanSeeOtherGuests: args.guestsCanSeeOtherGuests,
                anyoneCanAddSelf: args.anyoneCanAddSelf,
                conferenceData: args.conferenceData,
                extendedProperties: args.extendedProperties,
                attachments: args.attachments,
                source: args.source,
                eventType: args.eventType,
                ...(args.eventId && { id: args.eventId }), // Include custom ID if provided
                ...(args.focusTimeProperties && { focusTimeProperties: args.focusTimeProperties }),
                ...(args.eventType === 'outOfOffice' && { outOfOfficeProperties: this.buildOutOfOfficeProperties(args) }),
                ...(args.eventType === 'workingLocation' && { workingLocationProperties: this.buildWorkingLocationProperties(args) })
            };
            
            stampClaudia(requestBody);
            // Phase 0 write gate: normalise -> ensure envelope -> validate.
            // AFTER stampClaudia, never before: ensureEnvelope is fill-if-absent,
            // so the Trip Feed stamp survives only if it is already present.
            // The create-only gate additionally REQUIRES a real claudia_source.
            // Measured 2026-09-15 (tracker C26): a real agent ingest wrote 22
            // events all carrying the generic default, so none took a derived id
            // and re-running the document would have duplicated all 22. The rule
            // had been written in the calendar-write skill since 2026-09-14 and
            // was simply not followed — an instruction is not an enforcement.
            //
            // Behind a switch, and defaulting OFF, for two measured reasons.
            // (1) `create-event` is a general MCP tool: making the rule
            // unconditional turned 29 of this repo's own upstream tests red,
            // tests that know nothing about Claudia. (2) This writes to a live
            // family calendar, so a misfire means Claudia cannot create events
            // at all; one config value and a restart beats a rebuild when that
            // is the failure you are recovering from.
            //
            // Updates are never subject to it: they address an existing row by
            // id, and the source is only ever used to derive an id at insert.
            // R2 (tracker C47): classify the location from the venue KB BEFORE the
            // envelope's fill-if-absent defaults, so a known venue lands resolved/
            // high/venue_kb instead of the unclassified/n/a every agent write
            // carried until 2026-09-18. A caller's own policy is never overruled;
            // an unknown venue stays unclassified; no KB means no claim.
            classifyLocationAtWrite(requestBody);
            const requireCreateSource = process.env.CALENDAR_REQUIRE_CREATE_SOURCE === '1';
            applyWriteEnvelope(requestBody, undefined, { isCreate: requireCreateSource });

            // D1: derive the event id from the row rather than letting the
            // server assign one. Done AFTER the envelope, so the hash covers
            // the normalised body and stays stable across re-ingests.
            // No-op unless the payload names a real claudia_source — callers
            // that have not opted in keep server-assigned ids.
            const derived = deriveIdFromBody(requestBody, args.eventId);
            const desiredHash = derived ? contentHash(requestBody) : null;
            bodyUsed = requestBody;
            if (derived) {
                derivedIdUsed = derived.eventId;
                naturalKeyUsed = derived.naturalKey;
                desiredHashUsed = desiredHash;
                requestBody.id = derived.eventId;
                const priv = (requestBody.extendedProperties!.private ?? {}) as Record<string, string>;
                priv.claudia_natural_key = derived.naturalKey;
                priv.claudia_key_version = derived.keyVersion;
                priv.claudia_content_hash = desiredHash!;
            }

            // 1.12: THE ADOPTION PATH. A Calendar event id is fixed at insert
            // and cannot be changed, so every row written before Phase 1 carries
            // a server-assigned id it can never trade for a derived one. Insert
            // alone therefore CANNOT converge onto it: the derived id does not
            // exist, the insert returns 201, the 409 branch never fires, and the
            // calendar ends with two copies. That is the exact defect D1
            // prevents, arriving through the one door D1 does not cover (C23).
            //
            // `claudia_natural_key` is queryable server-side, so the key finds
            // the row the id cannot. Only runs when the write is idempotent, so
            // every caller that has not opted in is untouched — which is also
            // why this adds no list call to the general `create-event` path.
            //
            // NOT the read-before-write D1 rejected: that rejection is about
            // duplicate PREVENTION, where a read narrows the race without
            // closing it. The derived id and the 409 branch remain the only
            // authority on races. If this lookup races and loses, the insert
            // still lands on the derived id and the 409 branch still decides.
            //
            // FAILS OPEN, deliberately. If the lookup errors we fall through to
            // the insert — i.e. exactly today's behaviour, which risks a
            // duplicate. Failing closed would mean a Calendar read blip stops
            // Claudia writing at all, and the person who finds out is Zig.
            // 3.1d. Read the ledger ONCE, before either branch can need it: a
            // reconcile cannot happen mid-create, and re-reading would make the
            // outcome depend on timing. Empty when the file is absent — which is
            // its normal state today — so every cancelled row suppresses exactly
            // as it did before this landed.
            if (derived) reconciledUsed = reconciledKeys();

            if (derived) {
                let keyMatches: any[] | null = null;
                try {
                    const found = await calendar.events.list({
                        calendarId: args.calendarId,
                        privateExtendedProperty: [`claudia_natural_key=${derived.naturalKey}`],
                        showDeleted: true,     // a deleted row must not be re-created under a new id
                        singleEvents: false,   // masters, not occurrences (invariant 5)
                        maxResults: 10,
                    });
                    keyMatches = found.data.items ?? [];
                } catch (lookupError: any) {
                    process.stderr.write(JSON.stringify({
                        event: 'key_lookup_failed', natural_key: derived.naturalKey,
                        error: String(lookupError?.message ?? lookupError),
                        note: 'falling through to insert (pre-1.12 behaviour)',
                    }) + '\n');
                }

                if (keyMatches !== null) {
                    const { action, targetId } = decideOnKeyMatch(
                        keyMatches, desiredHash!, derived.eventId,
                        { naturalKey: derived.naturalKey, reconciledKeys: reconciledUsed });

                    if (action === ACTION_AMBIGUOUS) {
                        throw new Error(
                            `Natural key '${derived.naturalKey}' is claimed by ${keyMatches.length} ` +
                            `events. Not guessing which one to patch — key_v1 excludes times, so two ` +
                            `distinct events on one date with one title share a key. Give one a ` +
                            `claudia_section, or reconcile them by hand.`);
                    }
                    if (action === ACTION_SUPPRESSED) {
                        throw new Error(
                            `An event for natural key '${derived.naturalKey}' was deliberately ` +
                            `deleted; not recreating it under a new id. Lift the suppression ` +
                            `explicitly if it is wanted again.`);
                    }
                    if (action === ACTION_NOOP && targetId) {
                        const got = await calendar.events.get({
                            calendarId: args.calendarId, eventId: targetId,
                        });
                        return got.data;       // unchanged document; do not churn the row
                    }
                    if (action === ACTION_REVIVE && targetId) {
                        // The adoption branch's mirror: a row this pipeline
                        // cancelled, under a non-derived id, now listed again.
                        // `status` is set explicitly because a merge PATCH
                        // leaves an omitted field alone — without it the row
                        // would be updated and stay cancelled, which reads as a
                        // successful revive and is not one.
                        const { id: _immutable, ...reviveBody } = requestBody as any;
                        reviveBody.status = 'confirmed';
                        const revived = await calendar.events.patch({
                            calendarId: args.calendarId, eventId: targetId,
                            requestBody: reviveBody, sendUpdates: args.sendUpdates,
                        });
                        const noted = recordRevive({
                            naturalKey: derived.naturalKey,
                            source: (requestBody.extendedProperties?.private as any)
                                ?.claudia_source ?? '',
                            eventId: targetId,
                        });
                        process.stderr.write(JSON.stringify({
                            event: 'key_revive', natural_key: derived.naturalKey,
                            revived_id: targetId, ledger_updated: noted,
                        }) + '\n');
                        pokeTripFeed(revived.data?.id);
                        return revived.data;
                    }
                    if (action === ACTION_ADOPT && targetId) {
                        // Patch the row that EXISTS. `id` is stripped because an
                        // event id is immutable — sending it would ask Google to
                        // change the one thing it will not change.
                        const { id: _immutable, ...patchBody } = requestBody as any;
                        const adopted = await calendar.events.patch({
                            calendarId: args.calendarId, eventId: targetId,
                            requestBody: patchBody, sendUpdates: args.sendUpdates,
                        });
                        process.stderr.write(JSON.stringify({
                            event: 'key_adoption', natural_key: derived.naturalKey,
                            adopted_id: targetId, derived_id: derived.eventId,
                        }) + '\n');
                        pokeTripFeed(adopted.data?.id);
                        return adopted.data;
                    }
                }
            }

            // Determine if we need to enable conference data or attachments
            const conferenceDataVersion = args.conferenceData ? 1 : undefined;
            const supportsAttachments = args.attachments ? true : undefined;

            const response = await calendar.events.insert({
                calendarId: args.calendarId,
                requestBody: requestBody,
                sendUpdates: args.sendUpdates,
                ...(conferenceDataVersion && { conferenceDataVersion }),
                ...(supportsAttachments && { supportsAttachments })
            });
            
            if (!response.data) throw new Error('Failed to create event, no data returned');
            pokeTripFeed(response.data.id);
            return response.data;
        } catch (error: any) {
            // D1: a 409 on a DERIVED id is not a collision to avoid — it is
            // the signal that a previous attempt landed. Branch on what is
            // actually there rather than failing the caller.
            //
            // The cancelled branch is the one that matters: five Claudia-written
            // events were deliberately deleted, and a handler that revived on
            // 409 brings them all back on the next ingest. A user deletion is a
            // decision, and the pipeline treats it as durable state.
            if (error?.code === 409 || error?.response?.status === 409) {
                if (!derivedIdUsed) {
                    throw new Error(`Event ID '${args.eventId}' already exists. Please use a different ID.`);
                }
                let existing: any = null;
                try {
                    const got = await calendarUsed.events.get({
                        calendarId: args.calendarId, eventId: derivedIdUsed,
                    });
                    existing = got.data;
                } catch { existing = null; }

                const decision = decideOnConflict(existing, desiredHashUsed!, {
                    naturalKey: naturalKeyUsed, reconciledKeys: reconciledUsed,
                });
                if (decision === ACTION_NOOP) {
                    return existing;            // the retry's first write landed
                }
                if (decision === ACTION_REVIVE) {
                    // 3.1d on the 409 branch: the derived id exists but is
                    // cancelled, and the ledger says WE cancelled it. Patch it
                    // back rather than refusing forever.
                    const reviveBody = { ...(bodyUsed as any), status: 'confirmed' };
                    delete reviveBody.id;       // an event id is immutable
                    const revived = await calendarUsed.events.patch({
                        calendarId: args.calendarId, eventId: derivedIdUsed,
                        requestBody: reviveBody, sendUpdates: args.sendUpdates,
                    });
                    const noted = recordRevive({
                        naturalKey: naturalKeyUsed!,
                        source: (bodyUsed?.extendedProperties?.private as any)
                            ?.claudia_source ?? '',
                        eventId: derivedIdUsed!,
                    });
                    process.stderr.write(JSON.stringify({
                        event: 'conflict_revive', natural_key: naturalKeyUsed,
                        revived_id: derivedIdUsed, ledger_updated: noted,
                    }) + '\n');
                    pokeTripFeed(revived.data?.id);
                    return revived.data;
                }
                if (decision === ACTION_SUPPRESSED) {
                    throw new Error(
                        `Event '${derivedIdUsed}' was deliberately deleted; not recreating it. ` +
                        `Lift the suppression explicitly if it is wanted again.`);
                }
                if (decision === ACTION_PATCH) {
                    const patched = await calendarUsed.events.patch({
                        calendarId: args.calendarId, eventId: derivedIdUsed,
                        requestBody: bodyUsed!, sendUpdates: args.sendUpdates,
                    });
                    pokeTripFeed(patched.data?.id);
                    return patched.data;
                }
            }
            throw this.handleGoogleApiError(error);
        }
    }

    /**
     * Get default transparency and visibility based on event type
     */
    private getEventTypeDefaults(args: CreateEventInput): {
        transparency: string | undefined;
        visibility: string | undefined;
    } {
        // Use explicit values if provided
        let transparency = args.transparency;
        let visibility = args.visibility;

        switch (args.eventType) {
            case 'focusTime':
            case 'outOfOffice':
                // Focus Time and Out of Office block time by default
                if (!transparency) transparency = 'opaque';
                break;
            case 'workingLocation':
                // Working Location events are visible but don't block time
                if (!transparency) transparency = 'transparent';
                if (!visibility) visibility = 'public';
                break;
        }

        return { transparency, visibility };
    }

    /**
     * Build outOfOfficeProperties from args
     */
    private buildOutOfOfficeProperties(args: CreateEventInput): calendar_v3.Schema$EventOutOfOfficeProperties {
        const props = args.outOfOfficeProperties;
        return {
            autoDeclineMode: props?.autoDeclineMode || 'declineAllConflictingInvitations',
            ...(props?.declineMessage && { declineMessage: props.declineMessage })
        };
    }

    /**
     * Build workingLocationProperties from args
     */
    private buildWorkingLocationProperties(args: CreateEventInput): calendar_v3.Schema$EventWorkingLocationProperties {
        const props = args.workingLocationProperties;
        if (!props) {
            throw new Error('workingLocationProperties is required when eventType is "workingLocation"');
        }

        const properties: calendar_v3.Schema$EventWorkingLocationProperties = {
            type: props.type
        };

        switch (props.type) {
            case 'homeOffice':
                properties.homeOffice = {};
                break;
            case 'officeLocation':
                properties.officeLocation = props.officeLocation || {};
                break;
            case 'customLocation':
                properties.customLocation = props.customLocation || {};
                break;
        }

        return properties;
    }

    /**
     * Generate summary for working location events if not provided
     */
    private generateWorkingLocationSummary(args: CreateEventInput): string {
        const props = args.workingLocationProperties;
        if (!props) return 'Working location';

        switch (props.type) {
            case 'homeOffice':
                return 'Working from home';
            case 'officeLocation':
                return props.officeLocation?.label
                    ? `Working from ${props.officeLocation.label}`
                    : 'Working from office';
            case 'customLocation':
                return props.customLocation?.label
                    ? `Working from ${props.customLocation.label}`
                    : 'Working from custom location';
            default:
                return 'Working location';
        }
    }
}
