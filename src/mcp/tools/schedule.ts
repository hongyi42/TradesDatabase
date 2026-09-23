// The schedule: reads, booking, availability.
//
// One domain's slice of the spine's tool surface: the definitions it contributes
// to each tier's catalog, and the handler behind each name. Split out of
// src/mcp/server.ts on 2026-09-12 (research 2026-09-09
// code-graph-as-source-of-truth §6.1 fix 3) so that adding a tool here touches
// no file another feature is also editing.
//
// Tier membership is DECLARATIVE only: listing a tool under `admin` is what puts
// it in ADMIN_TOOL_NAMES, and the hub applies that gate by name before any
// handler here runs. A handler never checks a tier itself.
import {
  DURATION_LADDER,
  JOB_PRIORITIES,
  MAX_DURATION_MINUTES,
  WEEK_DAYS,
  addTimeOff,
  annotateResolvedReviewItem,
  appendJobCorrespondence,
  countUnscheduledOpenJobs,
  countUntimedVisits,
  deleteTimeOff,
  durationError,
  factSourceIds,
  findJobTypeDurationMinutes,
  findRetractionsFor,
  foldRetractedFacts,
  formatDuration,
  getCustomer,
  getJob,
  getOpenReviewItem,
  getTechnician,
  getTechnicianById,
  getTenant,
  getVisitForTenant,
  isValidDuration,
  isValidTimezone,
  latestScheduleVersion,
  listJobTypeDurations,
  listOpenJobsForCustomer,
  listParticipants,
  listTeam,
  listTimeOffForTechnician,
  resolveOpenReviewItemFor,
  resolveReviewItem,
  rowCapNote,
  setTechnicianAvailability,
  setTechnicianHorizonDays,
  setTenantTimezone,
  stageOf,
  unwrapAttributes,
  upsertJobTypeDuration,
  upsertOpenReviewItem,
} from '../../db/index.js';
import type {
  Job,
  JobPriority,
  Json,
  WeeklyPattern,
} from '../../db/index.js';
import {
  spineNowIso,
} from '../../evalClock.js';
import {
  listDayStops,
} from '../../routes/daySource.js';
import {
  buildMapsDeepLink,
  formatAddress,
} from '../../routes/deepLink.js';
import type {
  RouteStop,
} from '../../routes/deepLink.js';
import {
  localDateISO,
  localTimeHHMM,
  summarizeWeeklyPattern,
} from '../../schedule/availability.js';
import {
  readBoardDays,
  readLooseBucket,
} from '../../schedule/boardRead.js';
import {
  bookVisit,
  moveVisit,
  openWorkSteer,
  previewMoveVisit,
  previewUnscheduleVisit,
  spanMinutes,
  unscheduleVisit,
  wallClock,
} from '../../schedule/booking.js';
import {
  isRealDateISO,
  isWeekday,
  resolveDate,
  servedDayPhrase,
} from '../../schedule/dateResolve.js';
import {
  DRIVE_MEASURE_TOP,
  addDaysISO,
  assembleFitContext,
  findDisplacementCandidates,
  generateCandidates,
  measureDriveDeltas,
  techDateKey,
  weekdayLabel,
} from '../../schedule/fit.js';
import type {
  SlotCandidate,
} from '../../schedule/fit.js';
import {
  clampToTechnicianHorizon,
  horizonDaysFor,
} from '../../schedule/policy.js';
import {
  correspondenceOf,
} from '../../writePath/recordFieldNote.js';
import {
  inboundAskFor,
  resolveScheduleInputTarget,
} from './shared.js';
import type {
  DomainTools,
  ToolContext,
} from './types.js';

const BASE_TOOLS = [
  {
    name: 'resolve_date',
    description:
      'Turn a spoken day into a real calendar date. YOUR CLOCK IS WRONG: message timestamps you ' +
      "see are UTC, which from late afternoon onward names TOMORROW in the firm's timezone — so " +
      'NEVER state, count from, or filter by "today" without calling this first (the returned ' +
      '`today` is the firm-local date; a query window like "so far this year"/"through today" ' +
      'must end at THAT date, never at your clock\'s). Call this WHENEVER someone names a day ' +
      'relative to now — "today", "tomorrow", "this Friday", "next Tuesday", "the Friday after ' +
      'next week", "in 3 days" — BEFORE you book, move, or otherwise use the date. Do NOT work ' +
      'out the date yourself; you are unreliable at calendar math. Pass the parts you understood: ' +
      'a weekday with weeksAhead (0 = this coming one, 1 = next week\'s, 2 = the week after that), ' +
      'OR dayShift (0 = today, 1 = tomorrow, 3 = in three days), OR explicitDate if they gave an ' +
      'actual date. You get back {date, weekday, phrase, today, timezone}; USE the returned date. ' +
      'If it comes back unresolvable, ask the person which exact date they mean — never guess. ' +
      'NOTE: "next <weekday>" is genuinely ambiguous (this coming one vs the following week\'s) — ' +
      'resolve BOTH weeksAhead 0 and 1; for a read-only answer name the coming one first and ' +
      'offer the other, and ask which they mean before booking or moving anything. ' +
      'For week RANGES ("this week", "next week", "last week") pass week alone (0 = this week, ' +
      '1 = next, -1 = last) — you get back ' +
      '{weekStart, weekEnd, weekStartWeekday, weekEndWeekday, phrase}; on weekends "next week" ' +
      'comes back flagged ambiguous with an alternate range (which carries its own phrase) — for ' +
      'a read-only answer, answer BOTH ranges with their data, never with only a clarifying ' +
      'question; ask which range they mean before you act on either. ' +
      'For CALENDAR PERIODS pass exactly one of month ("this month" = 0, ' +
      '"last month" = -1), quarter ("this quarter" = 0, "last quarter" = -1), or year ' +
      '("this year" = 0, "last year" = -1) — you get back {periodStart, periodEnd, ' +
      'periodStartWeekday, periodEndWeekday, label, phrase}; use periodStart/periodEnd as your ' +
      'query window. Backward day references work too: "last Friday" = weekday:friday ' +
      'weeksAhead:-1. NEVER write a period boundary yourself — a first-of-month or "last month" ' +
      'across a year wrap is calendar math, and you are unreliable at it. ' +
      'WHEN YOU NAME ANY OF THESE DATES TO A PERSON, SAY THE `phrase` VERBATIM ' +
      '("Monday 2026-08-03 through Sunday 2026-08-09"). Never work out for yourself which day of ' +
      'the week a date falls on — that is the arithmetic this tool exists to do for you.',
    inputSchema: {
      type: 'object',
      properties: {
        weekday: {
          type: 'string',
          enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
          description: 'The named day, lowercase. Pair with weeksAhead.',
        },
        weeksAhead: {
          type: 'integer',
          description:
            'With weekday: 0 = this coming <day>, 1 = next week\'s, -1 = last <day> (the most recent past one). Default 0.',
        },
        week: {
          type: 'integer',
          description:
            '"this week" = 0, "next week" = 1, "last week" = -1. A week RANGE (Mon–Sun); use ALONE, without any other field.',
        },
        month: {
          type: 'integer',
          description:
            '"this month" = 0, "last month" = -1, "next month" = 1. A calendar-month RANGE; use ALONE.',
        },
        quarter: {
          type: 'integer',
          description: '"this quarter" = 0, "last quarter" = -1. A calendar-quarter RANGE; use ALONE.',
        },
        year: {
          type: 'integer',
          description: '"this year" = 0, "last year" = -1. A calendar-year RANGE; use ALONE.',
        },
        dayShift: {
          type: 'integer',
          description: 'Days from today when no weekday is named: 0 = today, 1 = tomorrow, -30 = thirty days ago.',
        },
        explicitDate: {
          type: 'string',
          description: 'YYYY-MM-DD, only when the person stated an exact calendar date.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_schedule',
    description:
      'Your schedule day by day: for each day in [from,to] (YYYY-MM-DD; both ' +
      "optional — default is today in the firm's timezone; range is capped at 14 days) returns " +
      'your stops IN THE ORDER THEY ARE BOOKED — the schedule is already set, so this never ' +
      "reorders it. Each stop's startTime is its booked time on the firm's own clock (HH:MM): " +
      'say it exactly as given, never convert it. Each stop carries mapsUrl, a Google Maps link that opens directions to THAT ' +
      'stop; relay it VERBATIM as a tappable link. mapsUrl null = that stop has no usable ' +
      'address on file — say so rather than guessing. ' +
      'days:[] means no stops in the range — UNLESS the result ' +
      'carries horizonNote: then days beyond the horizonEnd date are not published yet; relay ' +
      'the note, and NEVER tell the person they are free on unpublished days. When the result ' +
      "carries boardNote, ALWAYS end your reply with its exact [See it on the board](…) line — it " +
      'renders as a tappable link; no boardNote → say nothing about the board.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (default: today, UTC).' },
        to: { type: 'string', description: 'End date YYYY-MM-DD inclusive (default: from).' },
      },
      required: [],
    },
  },
];

const ADMIN_TOOLS = [
  {
    name: 'get_team_schedule',
    description:
      "The whole team's schedule, and a manager's ONLY schedule read (it includes visits you " +
      'hold yourself — there is no separate personal view). For [from,to] (YYYY-MM-DD; both ' +
      "optional — default today in the firm's timezone; capped at 14 days) it returns the " +
      'COUNTS PAGE: every day in the range with how many visits, how many are completed, how ' +
      'many have nobody attached (unassigned), and how many each technician has (byTechnician) — ' +
      'plus counts of untimed visits (booked with no time set) and open jobs with no visit at ' +
      'all. For ANY how-many/busiest/lightest/compare question USE THOSE NUMBERS VERBATIM; you ' +
      'are unreliable at counting, so never tally anything yourself. A day with 0 visits has ' +
      'nothing booked — whether someone can take more work is find_slots\' answer, never yours. ' +
      'The counts page names NO customers. For WHO is going WHERE (customer, address, times, crew) ' +
      'pass stops:true — add technicianRef for one person\'s visits — and you get 25 visits per ' +
      'page with a `next` value: copy it into `after` for the following page. ' +
      'Pass unassignedOnly:true for what still needs assigning, however far out or overdue: ' +
      'parked visits with nobody on them (overdue:true = the day passed with nobody attached), ' +
      'untimed visits (say "no time set yet", never a date) and jobs with no visit at all — 15 of ' +
      'each; for more pass queue ("visits" or "jobs") with that queue\'s `after`. Unassigned ' +
      'visits are attached with move_visit. Also returns scheduleVersion — quote it when ' +
      'discussing changes so staleness is detectable. When the result carries boardNote, ALWAYS ' +
      'end your reply with its exact [See it on the board](…) line — EVERY schedule answer ends ' +
      'with it, plain reads included; no boardNote → say nothing about the board.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (default: today).' },
        to: { type: 'string', description: 'End date YYYY-MM-DD inclusive (default: from).' },
        stops: {
          type: 'boolean',
          description:
            'true = also list the visits themselves (customer, address, times, crew), 25 per page. Omit for counts only.',
        },
        technicianRef: {
          type: 'string',
          description: 'With stops:true — only visits this person is on (a crew visit counts for every member).',
        },
        unassignedOnly: {
          type: 'boolean',
          description:
            'true = what still needs assigning: parked visits, untimed visits and jobs with no visit, from any date (`from`, `to` and the 14-day cap ignored).',
        },
        queue: {
          type: 'string',
          enum: ['visits', 'jobs'],
          description: 'With unassignedOnly:true — page just this list (25 per page) from its `after`.',
        },
        after: {
          type: 'string',
          description: 'The `next` value (or visitsNext/jobsNext) from the previous page, copied exactly.',
        },
      },
      required: [],
    },
  },
  {
    name: 'book_visit',
    description:
      'Book a visit onto the schedule (manager only). Done in ONE call ' +
      '({status:"booked"}) — ALWAYS tell the manager what was done (day, time, who, and any ' +
      'warning); never act silently. Before booking around a commitment the firm already ' +
      'made, READ the job\'s own record (get_job / list_recent_captures) — what a customer ' +
      'was told lives in what people actually said, not in a field. ' +
      'Call with date + startTime + endTime ' +
      '(+ customerId OR jobId; technicianRef optional). customerId MINTS A NEW JOB — when ' +
      'booking work already on file (a named job, a multi-day split, a return visit), pass ' +
      'that job\'s jobId instead: one job, many visits, never a duplicate job per day. ' +
      'GUARDED: when the customer has open work on file, a customerId booking with NO title ' +
      '— or a title naming a job already on file — is REFUSED with the open-jobs list: ' +
      're-call with the matching jobId. Genuinely NEW work books normally under its own ' +
      'distinct title (forceNewJob:true also overrides). Best practice: read ' +
      'get_customer_context FIRST and book by jobId, skipping the refusal round trip. ' +
      'startTime and endTime are REQUIRED ' +
      '— the server assumes NO default length. Pass exactly the times the manager stated ' +
      '(a range like "12-1pm" means startTime 12:00 AND endTime 13:00); if the manager did ' +
      'not say when the visit starts or ends, ASK them — never guess. ONE exception: when the ' +
      'manager says the timing is not settled ("book them in, we will find a slot"), pass ' +
      '`untimed: true` AND none of date/startTime/endTime — the visit books UNTIMED and waits ' +
      'in the unscheduled queue until someone places it with move_visit. You must SAY untimed; ' +
      'leaving the day out is refused, because an omission is not a decision. Booking untimed ' +
      'is never your own choice when a day or a time was stated — if you were given a day but ' +
      'no times, ask for the times. Omit technicianRef to ' +
      'book WITHOUT a technician (put it on the calendar, assign later — attach someone with ' +
      'move_visit; find these via get_team_schedule unassignedOnly:true). ' +
      'SEVERAL PEOPLE ON ONE TRIP: pass technicianRefs with every ref ("Ben and Joy on the ' +
      'Henderson job") — that is ONE visit carrying a crew, not two bookings. Booking it ' +
      'twice makes two separate trips, each chased and reported separately. ' +
      'When talking to customers, offer DAYS, not times. ' +
      'When the result carries dayPhrase, SAY IT VERBATIM whenever you name the day — never ' +
      'work out the weekday yourself; you are unreliable at calendar math. ' +
      'When the result carries boardNote, ALWAYS end your report with its exact ' +
      '[See it on the board](…) line — it renders as a tappable link.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Exactly one of customerId/jobId.' },
        jobId: { type: 'string', description: 'Exactly one of customerId/jobId.' },
        technicianRef: { type: 'string', description: 'Roster ref of ONE technician — shorthand for a one-person crew. OPTIONAL — omit to book unassigned ("assign later").' },
        technicianRefs: { type: 'array', items: { type: 'string' }, description: 'Roster refs of EVERY technician going on this trip. Two people on one job at one time is ONE visit with both refs here — never two book_visit calls.' },
        title: { type: 'string', description: 'Job title when booking by customerId (a new job is created).' },
        date: { type: 'string', description: 'YYYY-MM-DD, firm-local. Required WITH both times. Omitting it is NOT how you book without a day — that is `untimed: true`, and an omission is refused.' },
        startTime: { type: 'string', description: 'HH:MM 24h. Required with date and endTime — no default; ask the manager if unstated.' },
        endTime: { type: 'string', description: 'HH:MM 24h. Required with date and startTime — no default length; ask the manager if unstated.' },
        untimed: {
          type: 'boolean',
          description:
            'true books with NO day and no times, for work the manager said is not scheduled ' +
            'yet ("book them in, we will find a slot"). It is the ONLY way to book without a ' +
            'day — omitting date/startTime/endTime is refused. Never pass it when a day was ' +
            'stated: book that day instead, asking for the times if you were not given them.',
        },
        priority: { type: 'string', enum: ['emergency', 'urgent', 'routine', 'maintenance'], description: 'Triage tier for the NEW job when booking by customerId (default "routine"). Rejected with jobId — an existing job keeps its recorded priority.' },
        forceNewJob: { type: 'boolean', description: 'customerId path only: override the open-work guard and mint a new job even though the customer has open work on file. ONLY when the work is genuinely different from every listed job — never to skip the jobId lookup.' },
      },
      required: [],
    },
  },
  {
    name: 'move_visit',
    description:
      'Move a booked visit (manager only) — also how a technician gets ATTACHED to an ' +
      'unassigned visit (pass technicianRef with the same day/time), and how one gets TAKEN ' +
      'OFF: unassign:true parks the visit — pulls everyone off, keeps day/time; find it ' +
      'under get_team_schedule unassignedOnly:true or the board\'s loose bucket. Reversible ' +
      'and internal → done in ONE call ({status:"moved"}) — ALWAYS tell the ' +
      'manager what moved; never act silently. Before moving a visit, READ the job\'s own ' +
      'record (get_job / list_recent_captures): if the firm told this customer a day or a ' +
      'time, moving it is a promise someone must now un-tell them. Call with visitId + ' +
      'date + startTime (+ optional endTime/technicianRef/technicianRefs OR unassign) + reason. ' +
      'technicianRefs REPLACES the crew: to ADD a second person to a visit, pass BOTH refs, ' +
      'or the one already on it comes off. When the ' +
      'result carries ' +
      'boardNote, ALWAYS end your report with its exact [See it on the board](…) line — it ' +
      'renders as a tappable link. When the result carries dayPhrase, SAY IT VERBATIM whenever ' +
      'you name the new day — never work out the weekday yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        visitId: { type: 'string', description: 'The visit to move (from get_team_schedule).' },
        date: { type: 'string', description: 'New YYYY-MM-DD.' },
        startTime: { type: 'string', description: 'New HH:MM.' },
        endTime: { type: 'string', description: 'New HH:MM (default: keep the old duration).' },
        technicianRef: { type: 'string', description: 'Reassign to THIS ONE person — it REPLACES the crew, so anyone else on the visit comes off. To keep them, pass technicianRefs with every ref instead. Omit both to leave the crew unchanged. Mutually exclusive with unassign.' },
        technicianRefs: { type: 'array', items: { type: 'string' }, description: 'The crew AFTER the move — it REPLACES whoever is on the visit, so list everyone still going, not just the person being added. Omit to keep the crew unchanged. Mutually exclusive with unassign.' },
        unassign: { type: 'boolean', description: 'true = park the visit: pull EVERYONE off, keep day/time (the reverse of attaching). Mutually exclusive with technicianRef/technicianRefs.' },
        reason: { type: 'string', description: 'Why it is moving (kept on the record).' },
      },
      required: [],
    },
  },
  {
    name: 'unschedule_visit',
    description:
      'Take a booked visit OFF the calendar (manager only). The WORK is NOT cancelled: the ' +
      'job returns to the loose bucket for rebooking — say so in your report. For "the ' +
      'customer called the whole thing off / we are not doing this work", use cancel_job ' +
      'instead. If the manager\'s words could mean either ("cancel the Hendersons"), ASK ' +
      'which they mean — never guess. Cancelling a visit that is ON THE CALENDAR is ' +
      'externally visible — a customer is expecting it — so that is TWO-STEP: you ' +
      'get {status:"needs_confirmation", confirmId} with a preview — show it, get an explicit ' +
      'yes, call again with ONLY confirmId. Call with visitId + reason. When the result ' +
      'carries boardNote, ALWAYS end your ' +
      'report with its exact [See it on the board](…) line — it renders as a tappable link.',
    inputSchema: {
      type: 'object',
      properties: {
        visitId: { type: 'string', description: 'The visit to unschedule. First call only.' },
        reason: { type: 'string', description: 'Why (kept on the record). First call only.' },
        confirmId: { type: 'string', description: 'Set ONLY on the confirming second call.' },
      },
      required: [],
    },
  },
  {
    name: 'find_slots',
    description:
      'Find bookable schedule slots (manager only) — READ-ONLY, it books NOTHING. This tool ' +
      'is the ONLY source of scheduling truth: NEVER judge fit, availability, or drive time ' +
      'yourself — call it and relay its verdict. Give exactly ONE subject: customerId ' +
      '(genuinely NEW work only — GUARDED: refused with the open-jobs list when the customer ' +
      'already has open work on file; re-call with the matching jobId, or forceNewJob:true ' +
      'only for truly different new work), jobId (work on a recorded job — the usual case), ' +
      'or visitId (re-placing or assigning an ' +
      "existing visit — its booked length is used). Returns up to 5 ranked candidates, each " +
      'with technician, date, times, and a human-ready reasons line — RELAY those reasons, ' +
      'do not invent your own. Every date comes WITH its weekday (the weekday field, also in ' +
      'the reason text) — USE that name verbatim and NEVER work out weekday names yourself; ' +
      'you are unreliable at calendar math. dayLevel:true = a LOOSE day: quote the DAY to ' +
      'the manager, not the exact time. Concrete slots are bookable verbatim with book_visit. Duration is ' +
      'NEVER assumed: pass durationMinutes when the manager stated a length; otherwise the ' +
      "job's own recorded length (update_job), then its stored type duration, applies — and " +
      'the result DISCLOSES which (durationAssumption — ' +
      'relay it). If no duration is known you get an error listing the remedies: set the ' +
      "job's length, map it onto a configured type (pass assumedType), or ask the manager — " +
      'never guess minutes. ' +
      'requiredSkills excludes ONLY people whose configured skill list lacks the skill; ' +
      'people with NO skills recorded are included with a confirm-first warning. When ' +
      'nothing fits, the result names the binding constraint plus displacement candidates ' +
      '(what could move) — present those options; never a bare "impossible".',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Exactly one of customerId/jobId/visitId.' },
        jobId: { type: 'string', description: 'Exactly one of customerId/jobId/visitId.' },
        visitId: {
          type: 'string',
          description:
            'Exactly one of customerId/jobId/visitId — find who/when could take this ' +
            'existing visit (its own current slot is ignored while searching).',
        },
        durationMinutes: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_DURATION_MINUTES,
          description:
            'Visit length in whole minutes WHEN THE MANAGER STATED ONE — beats any stored ' +
            'duration.',
        },
        assumedType: {
          type: 'string',
          description:
            'Your mapping of an UNTYPED job onto a configured job type (use after the ' +
            'no-duration error lists the choices). The result labels it as your guess — ' +
            'refused whenever the duration is already known: typed jobs, jobs with a ' +
            'recorded length, and existing visits (their booked length applies).',
        },
        technicianRef: { type: 'string', description: 'Pin the search to one roster ref.' },
        forceNewJob: {
          type: 'boolean',
          description:
            'customerId subject only: override the open-work guard and search for a brand-new ' +
            "job even though the customer has open work on file. ONLY when the work is " +
            'genuinely different from every listed job.',
        },
        requiredSkills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Skills the job needs. Omit unless the manager asked for a skill.',
        },
        earliestDate: { type: 'string', description: 'YYYY-MM-DD (default today).' },
        latestDate: {
          type: 'string',
          description: 'YYYY-MM-DD inclusive (default 13 days after today; span capped at 14 days).',
        },
      },
      required: [],
    },
  },
  {
    name: 'set_availability',
    description:
      "Set a team member's weekly working pattern (manager only). Done immediately in ONE " +
      'call — tell the manager exactly what was stored. THIS IS THE STEP THAT MAKES A PERSON ' +
      'SCHEDULABLE: no pattern = the scheduler will never book them (manual booking still ' +
      'works, with a warning). pattern is a JSON object with ALL SEVEN lowercase day keys ' +
      'mon..sun, each an array of ["HH:MM","HH:MM"] windows (24h; end may be "24:00"; empty ' +
      'array = not working that day). Example — Mon–Fri 8 to 5: {"mon":[["08:00","17:00"]],' +
      '"tue":[["08:00","17:00"]],"wed":[["08:00","17:00"]],"thu":[["08:00","17:00"]],' +
      '"fri":[["08:00","17:00"]],"sat":[],"sun":[]}. Works for schedule-only (seatExempt) ' +
      'people too — it is exactly how they become schedulable.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The roster ref.' },
        pattern: {
          type: 'object',
          description: 'The weekly pattern object — all 7 day keys, see the example above.',
        },
      },
      required: ['ref', 'pattern'],
    },
  },
  {
    name: 'get_availability',
    description:
      "Read back a team member's CONFIGURED weekly working pattern — the counterpart to " +
      'set_availability, and the tool for "when does X work?", "what is X\'s availability?", ' +
      '"who works Saturdays?". Give ref for one person; omit it for the whole active roster. ' +
      'Returns a ready-to-relay summary line per person ("Mon–Fri 08:00–17:00; Sat, Sun off") ' +
      '— RELAY that line, do not re-render the pattern object yourself. Also returns any time ' +
      'off in the next 30 days, which overrides the pattern on those dates. ' +
      'configured:false means no pattern is set: that person is NOT schedulable and the fix is ' +
      'set_availability — say so rather than reporting them as free. ' +
      'IMPORTANT: this is what someone is set up to work, NOT what is actually bookable — it ' +
      'does not know about visits already booked. For bookability ALWAYS use find_slots, ' +
      'which remains the only source of scheduling truth.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'The roster ref of one person. Omit to get the whole active roster.',
        },
      },
    },
  },
  {
    name: 'add_time_off',
    description:
      'Record whole-day time off for a team member (manager only): vacation, sick days, ' +
      'appointments. Done immediately in ONE call — tell the manager exactly what was ' +
      'recorded. Dates are inclusive; a single day = same startsOn and endsOn. The scheduler ' +
      'will not book the person on these days; manual booking warns.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The roster ref.' },
        startsOn: { type: 'string', description: 'First day off, YYYY-MM-DD (inclusive).' },
        endsOn: { type: 'string', description: 'Last day off, YYYY-MM-DD (inclusive).' },
        reason: { type: 'string', description: 'Optional short reason (kept on the record).' },
      },
      required: ['ref', 'startsOn', 'endsOn'],
    },
  },
  {
    name: 'remove_time_off',
    description:
      'Remove recorded time off (manager only): deletes EVERY time-off range that overlaps ' +
      'the given date for that person. Done immediately in ONE call — report exactly which ' +
      'ranges were removed. Zero matches is a clean answer, not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The roster ref.' },
        date: { type: 'string', description: 'Any date (YYYY-MM-DD) inside the range(s) to remove.' },
      },
      required: ['ref', 'date'],
    },
  },
  {
    name: 'set_job_duration',
    description:
      'Set a DEFAULT length for new jobs of a type (manager only), e.g. "maintenance takes 60 ' +
      'minutes", "installs take 8 hours" (pass minutes: 480). A SUGGESTION, not the source of ' +
      "truth: each job's own durationMinutes (update_job) always wins over the type default. " +
      'Done immediately in ONE call — ' +
      'echo what was stored. Job types are free text, matched case-insensitively; setting an ' +
      'existing type replaces its minutes. The scheduler NEVER assumes a duration: jobs with ' +
      'no own length and no configured type require the manager to state one.',
    inputSchema: {
      type: 'object',
      properties: {
        jobType: { type: 'string', description: 'The job type, e.g. "install", "maintenance".' },
        minutes: { type: 'integer', description: 'Whole minutes the type takes (> 0).' },
      },
      required: ['jobType', 'minutes'],
    },
  },
  {
    name: 'set_technician_horizon',
    description:
      'Set how far ahead TECHNICIANS can see the schedule (manager only), in whole weeks ' +
      '(1-12; default 4). Done immediately in ONE call — echo old → new. Beyond the horizon ' +
      'their schedule reads and board views answer "not published yet"; managers always see ' +
      'everything. Tune it to the firm: fast-filling schedules may want more visible weeks, ' +
      'slow ones fewer. get_team_schedule shows the current value (technicianHorizonDays).',
    inputSchema: {
      type: 'object',
      properties: {
        weeks: {
          type: 'integer',
          description: 'Whole weeks ahead technicians may see (1-12).',
        },
      },
      required: ['weeks'],
    },
  },
  {
    name: 'set_timezone',
    description:
      "Set the firm's timezone (manager only). Done immediately in ONE call — echo old → new. " +
      'Takes an IANA name like "America/Chicago"; abbreviations ("CST", "Central") are REFUSED ' +
      'because they cannot say whether the firm observes daylight saving. DO NOT ASK THE ' +
      'MANAGER FOR A TIMEZONE — ask where they are based (you need the city for the firm ' +
      'profile anyway) and derive it. Texas, Florida, Indiana, Arizona, Kentucky, Tennessee, ' +
      'the Dakotas, Nebraska, Kansas, Idaho, Oregon and Michigan span two zones or skip DST, ' +
      'so for those ask what time it is there right now and derive from that instead of ' +
      'guessing. The result carries localTime — READ IT BACK to the manager ("it\'s 3:42pm for ' +
      "you\") rather than the zone name: nobody can check \"America/Chicago\", everybody can " +
      'check a clock. Every date in the system is read in this zone, and a wrong one is ' +
      'silent — nothing errors, the dates are just wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone name, e.g. "America/Chicago".',
        },
      },
      required: ['timezone'],
    },
  },
];

async function handleResolveDate(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
      // "Now" is the SERVER's clock in the FIRM's timezone — never a model
      // input, so the caller cannot assert a wrong today. The agent supplies
      // only the parsed parts of the phrase; the arithmetic is deterministic
      // (src/schedule/dateResolve.ts). Returning today+timezone also grounds
      // the agent for whatever it does next.
      const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
      // spineNowIso: real clock unless EVAL_FAKE_NOW anchors THIS tenant
      // (the date-eval's any-hour regime — see src/evalClock.ts).
      const todayLocal = localDateISO(spineNowIso(tenantId), tz);
      const weekdayArg = str('weekday');
      if (weekdayArg !== undefined && !isWeekday(weekdayArg)) {
        throw new Error(`invalid weekday: ${weekdayArg} (use a lowercase day name)`);
      }
      // Accept a stringified integer too — models sometimes quote numbers.
      const intArg = (k: string): number | undefined => {
        const v = args[k];
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v);
        return undefined;
      };
      const result = resolveDate({
        todayLocal,
        ...(weekdayArg ? { weekday: weekdayArg } : {}),
        ...(intArg('weeksAhead') !== undefined ? { weeksAhead: intArg('weeksAhead') } : {}),
        ...(intArg('dayShift') !== undefined ? { dayShift: intArg('dayShift') } : {}),
        ...(str('explicitDate') ? { explicitDate: str('explicitDate') } : {}),
        ...(intArg('week') !== undefined ? { week: intArg('week') } : {}),
        ...(intArg('month') !== undefined ? { month: intArg('month') } : {}),
        ...(intArg('quarter') !== undefined ? { quarter: intArg('quarter') } : {}),
        ...(intArg('year') !== undefined ? { year: intArg('year') } : {}),
      });
      return { ...result, today: todayLocal, timezone: tz };
}

async function handleGetSchedule(toolCtx: ToolContext): Promise<unknown> {
  const { args, identity, tenantId, str } = toolCtx;
      // Whose schedule = the badge identity, never an arg — a technician can
      // only ever fetch their own days.
      // Non-string args must be rejected, not coerced: str() maps {from: 123}
      // to undefined and the default would silently answer about TODAY with
      // status ok (the SDK does not validate args against inputSchema).
      if (
        (args.from !== undefined && typeof args.from !== 'string') ||
        (args.to !== undefined && typeof args.to !== 'string')
      ) {
        return { status: 'invalid_range', note: 'from/to must be YYYY-MM-DD strings' };
      }
      // Default "today" is the FIRM's local day, not UTC: for a Pacific-time
      // tenant every evening ask would otherwise default to tomorrow. The
      // tenant row is fetched ALWAYS now (not only when from is absent): the
      // horizon clamp below needs today + technician_horizon_days regardless
      // — one read serves both.
      const scheduleTenant = await getTenant(tenantId);
      const today = localDateISO(
        new Date().toISOString(),
        scheduleTenant?.timezone ?? 'UTC',
      );
      let from = str('from');
      let to = str('to');
      // Truthiness, not ??=: agents routinely emit "" for optional params —
      // an empty from meant "today" on main and still does on the board API,
      // so it must keep meaning that here (final-review finding: the hoist
      // briefly turned "" into invalid_range and diverged the two surfaces).
      if (!from) from = today;
      if (!to) to = from;
      const DATE = /^\d{4}-\d{2}-\d{2}$/;
      if (!DATE.test(from) || !DATE.test(to) || from > to) {
        return { status: 'invalid_range', note: 'from/to must be YYYY-MM-DD with from <= to' };
      }
      const spanDays =
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      // Regex-valid but impossible dates (month 13) parse to NaN — reject them
      // with an accurate note, distinct from the span cap.
      if (!Number.isFinite(spanDays)) {
        return { status: 'invalid_range', note: 'from/to is not a real calendar date' };
      }
      if (spanDays > 14) {
        return { status: 'invalid_range', note: 'range is capped at 14 days' };
      }
      // Technician visibility horizon (Plan 4a) — this tool is technician-only
      // (managers are blocked at dispatch), so no tier test. Clamp AFTER
      // validation: garbage stays invalid_range, never a quiet clamp. Trim +
      // note, not an error — the payload explains the missing days itself.
      // The policy lives in ONE place (schedule/policy.ts) shared with the
      // board; horizonEnd rides structured so clients branch on data.
      const clamp = clampToTechnicianHorizon(today, from, to, horizonDaysFor(scheduleTenant));
      if (clamp.beyond) {
        return {
          status: 'ok',
          from,
          to,
          days: [],
          horizonNote: clamp.horizonNote,
          horizonEnd: clamp.horizonEnd,
        };
      }
      to = clamp.to;
      const dayStops = await listDayStops(tenantId, identity.technicianRef, from, to);
      // listDayStops already sorts by time, and that IS the answer: the schedule
      // is set, so a read renders it. NEVER reordered here — deciding the order
      // means MOVING visits (promises, confirmation, a DB write), which is the
      // manager's call through move_visit, not a read's.
      //
      // Each stop carries its own single-destination link rather than one
      // multi-waypoint day link: no waypoint cap (so no truncation at 10 stops),
      // and it matches how the day is actually driven — navigate to the next
      // stop, not the whole day at once. Address-less stops therefore stay in
      // the one chronological list with a null link; the old routable/unroutable
      // split existed only to protect a DRIVE-ordered sequence, which is gone.
      //
      // THE TIME GOES OUT AS WALL CLOCK, never the stored timestamp. Visits are
      // stored naive-local (src/schedule/booking.ts: the firm's wall clock written
      // as if UTC), so starts_at reads "2026-09-23T16:00:00+00:00" for a 4:00 PM
      // visit. A model that knows the firm's local time "converts" that '+00' and
      // tells the technician 9:00 AM (live, 2026-09-22, the Copilot SDK seat,
      // whose engine stamps each message in the firm's timezone). startTime is the
      // HH:MM as booked, the same shape get_customer_context already uses.
      const days = dayStops.map((day) => ({
        date: day.date,
        stops: day.stops.map(({ scheduledStart, ...s }) => ({
          ...s,
          startTime: scheduledStart ? scheduledStart.slice(11, 16) : null,
          mapsUrl: s.address === null ? null : buildMapsDeepLink([s]).url,
        })),
      }));
      return {
        status: 'ok',
        from,
        to,
        days,
        ...(clamp.horizonNote
          ? { horizonNote: clamp.horizonNote, horizonEnd: clamp.horizonEnd }
          : {}),
      };
}

// THE COUNTS PAGE (retrieval layer 4, operator ruling 7, 2026-09-15). This read
// used to hand the model every stop of up to 14 days — the week, dumped into the
// seat's window, when the scheduling UI already carries the week view. It now
// returns counts by default and the stops themselves only when asked, a page at
// a time. The rules — which visits sit on which day, who is on a trip, what the
// loose bucket holds — are NOT restated here: they come from the board's own
// readers (src/schedule/boardRead.ts), which the board, the console and this
// tool share (operator, 2026-09-15: the schedule's one definition stays there).
const STOPS_PAGE = 25;
const RECALL_FIRST_PAGE = 15;
const RECALL_QUEUE_PAGE = 25;

// Element-wise string comparison of two sort keys. Every key component is fixed
// width or an id (YYYY-MM-DD, HH:MM, ISO timestamps from one column, uuids), so
// string order IS the intended order.
function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// One keyset page over rows already in key order. The cursor carries VALUES,
// not a position: a row that left the list between two calls (the manager just
// assigned it) cannot shift the next page — it starts strictly after the values.
function keysetPage<T>(
  rows: T[],
  keyOf: (row: T) => string[],
  after: string[] | null,
  size: number,
): { page: T[]; next: string | null } {
  const rest = after ? rows.filter((r) => compareKeys(keyOf(r), after) > 0) : rows;
  const page = rest.slice(0, size);
  return {
    page,
    next: rest.length > size ? keyOf(page[page.length - 1]).join('|') : null,
  };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STOP_CURSOR = new RegExp(`^\\d{4}-\\d{2}-\\d{2}\\|\\d{2}:\\d{2}\\|${UUID}$`, 'i');
const VISIT_CURSOR = new RegExp(`^(d\\|\\d{4}-\\d{2}-\\d{2}\\|\\d{2}:\\d{2}|u\\|[^|]+)\\|${UUID}$`, 'i');
const JOB_CURSOR = new RegExp(`^[^|]+\\|${UUID}$`, 'i');

async function handleGetTeamSchedule(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
      // Same validation contract as get_schedule (non-string rejection, firm-
      // local default day, 14-day cap) — manager-wide instead of self-only.
      if (
        (args.from !== undefined && typeof args.from !== 'string') ||
        (args.to !== undefined && typeof args.to !== 'string')
      ) {
        return { status: 'invalid_range', note: 'from/to must be YYYY-MM-DD strings' };
      }
      for (const key of ['unassignedOnly', 'stops'] as const) {
        if (args[key] !== undefined && typeof args[key] !== 'boolean') {
          return { status: 'invalid_range', note: `${key} must be a boolean` };
        }
      }
      for (const key of ['technicianRef', 'queue', 'after'] as const) {
        if (args[key] !== undefined && typeof args[key] !== 'string') {
          return { status: 'invalid_range', note: `${key} must be a string` };
        }
      }
      const unassignedOnly = args.unassignedOnly === true;
      const wantStops = args.stops === true;
      const technicianRef = str('technicianRef') || undefined;
      const queue = str('queue') || undefined;
      const after = str('after') || undefined;
      if (queue !== undefined && queue !== 'visits' && queue !== 'jobs') {
        return { status: 'invalid_range', note: 'queue must be "visits" or "jobs"' };
      }
      if (queue !== undefined && !unassignedOnly) {
        return { status: 'invalid_range', note: 'queue pages the unassignedOnly:true lists — pass unassignedOnly:true with it' };
      }
      // The recall lists are the firm's whole queue: a person filter or a stop
      // list there would be silently ignored, and the answer would read as
      // that person's. Refused in words instead.
      if (unassignedOnly && (technicianRef !== undefined || wantStops)) {
        return {
          status: 'invalid_range',
          note: 'unassignedOnly:true lists the whole queue — technicianRef and stops apply to the dated schedule read, not to it',
        };
      }
      if (unassignedOnly && after !== undefined && queue === undefined) {
        return { status: 'invalid_range', note: 'after needs queue ("visits" or "jobs") — say which list you are paging' };
      }
      if (!unassignedOnly && (after !== undefined || technicianRef !== undefined) && !wantStops) {
        return { status: 'invalid_range', note: 'after and technicianRef page the visit list — pass stops:true with them' };
      }
      // Tenant fetched regardless of `from` now: the response carries the
      // technician-horizon setting for discovery ("what is it now?" — Plan 4a;
      // manager tool, not the board button path, so one read is fine).
      const teamTenant = await getTenant(tenantId);
      const technicianHorizonDays = horizonDaysFor(teamTenant);

      if (unassignedOnly) {
        // THE LOOSE BUCKET — the board tray's own read, so the agent and the tray
        // agree by construction: parked visits from ANY date (an overdue one is
        // flagged, never dropped — the old recall view floored at today and lost
        // it), untimed visits, and open jobs with no visit. `from`/`to` are
        // ignored by design. The clock is the tenant's served one, so an
        // eval-anchored firm's `overdue` agrees with its own today.
        if (after !== undefined) {
          const shape = queue === 'jobs' ? JOB_CURSOR : VISIT_CURSOR;
          if (!shape.test(after)) {
            return { status: 'invalid_range', note: `after is not a ${queue} cursor — copy ${queue}Next exactly` };
          }
        }
        // Version BEFORE the snapshot (both modes): a booking that lands between
        // the two reads then makes a later "changed since version N?" check fire
        // (false positive, fail-safe) instead of vouching for a snapshot missing it.
        const scheduleVersion = await latestScheduleVersion(tenantId);
        const bucket = await readLooseBucket(tenantId, spineNowIso(tenantId));
        // Total order: dated parked visits by (day, start, id), then untimed ones
        // by (age, id) — the tray's order with an id tiebreak, so pages are stable.
        const visitKey = (v: (typeof bucket.parkedVisits)[number]): string[] =>
          v.date !== null
            ? ['d', v.date, v.startTime ?? '', v.visitId]
            : ['u', v.createdAt, v.visitId];
        const visits = [...bucket.parkedVisits]
          .sort((a, b) => compareKeys(visitKey(a), visitKey(b)))
          .map((v) => ({ ...v, technicianRef: v.technicianRefs[0] ?? null }));
        const jobKey = (j: (typeof bucket.unscheduledJobs)[number]): string[] => [j.createdAt, j.jobId];
        const jobs = [...bucket.unscheduledJobs].sort((a, b) => compareKeys(jobKey(a), jobKey(b)));
        const cursor = after ? after.split('|') : null;
        const visitsPage =
          queue === 'jobs'
            ? null
            : keysetPage(visits, visitKey, queue === 'visits' ? cursor : null,
                queue === 'visits' ? RECALL_QUEUE_PAGE : RECALL_FIRST_PAGE);
        const jobsPage =
          queue === 'visits'
            ? null
            : keysetPage(jobs, jobKey, queue === 'jobs' ? cursor : null,
                queue === 'jobs' ? RECALL_QUEUE_PAGE : RECALL_FIRST_PAGE);
        return {
          status: 'ok',
          unassignedOnly: true,
          scheduleVersion,
          technicianHorizonDays,
          counts: {
            parkedVisits: bucket.parkedVisits.filter((v) => v.date !== null).length,
            overdue: bucket.parkedVisits.filter((v) => v.overdue).length,
            untimed: bucket.parkedVisits.filter((v) => v.date === null).length,
            unscheduledJobs: bucket.unscheduledJobs.length,
          },
          ...(visitsPage ? { visits: visitsPage.page, visitsNext: visitsPage.next } : {}),
          ...(jobsPage ? { jobs: jobsPage.page, jobsNext: jobsPage.next } : {}),
          ...(bucket.unscheduledJobsRowCapHit ? { rowCapNote: rowCapNote('open jobs') } : {}),
          note:
            'visits are parked visits: date set and nobody on them (overdue:true = the day ' +
            'already passed with nobody attached), or date null = no time set yet — say "no ' +
            'time set yet" for those, never a date. jobs are open jobs with NO visit at all — ' +
            'booking one takes it off this list. Counts cover every row; the lists are pages: a ' +
            'non-null visitsNext/jobsNext means more — call again with queue and that value as ' +
            'after. Attach someone with move_visit.',
        };
      }

      let from = str('from');
      const to = str('to');
      // Truthiness, not ??=: an empty-string from means "today" (main/board
      // parity — same rule as get_schedule above).
      if (!from) from = localDateISO(spineNowIso(tenantId), teamTenant?.timezone ?? 'UTC');
      const DATE = /^\d{4}-\d{2}-\d{2}$/;
      if (!DATE.test(from)) {
        return { status: 'invalid_range', note: 'from must be YYYY-MM-DD' };
      }
      const toDay = to || from;
      if (!DATE.test(toDay) || from > toDay) {
        return { status: 'invalid_range', note: 'from/to must be YYYY-MM-DD with from <= to' };
      }
      const spanDays =
        (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      if (!Number.isFinite(spanDays)) {
        return { status: 'invalid_range', note: 'from/to is not a real calendar date' };
      }
      if (spanDays > 14) {
        return { status: 'invalid_range', note: 'range is capped at 14 days' };
      }
      if (after !== undefined && !STOP_CURSOR.test(after)) {
        return { status: 'invalid_range', note: 'after is not a visit-list cursor — copy `next` exactly' };
      }
      // An unknown person is an error, never an empty list that reads as "they
      // have nothing on".
      if (technicianRef !== undefined && !(await getTechnician(tenantId, technicianRef))) {
        return {
          status: 'invalid_range',
          note: `no team member with ref '${technicianRef}' — call list_team and use a ref exactly as spelled there`,
        };
      }

      const scheduleVersion = await latestScheduleVersion(tenantId);
      // Past days read as HISTORY: completed visits count (the console's status
      // set, user decision 2026-09-07). Reading confirmed alone made a finished
      // day look empty, and the old note called it free.
      const [board, untimedCount, unscheduled] = await Promise.all([
        readBoardDays({ tenantId, from, to: toDay, statuses: ['confirmed', 'completed'] }),
        countUntimedVisits(tenantId),
        // The COUNT, not the queue: the rows themselves are the recall view's.
        countUnscheduledOpenJobs(tenantId),
      ]);

      // The board draws ONE LANE PER PERSON (a crew trip appears in each lane);
      // counts here are of TRIPS, so a lane pair is one visit — except in
      // byTechnician, which is exactly the per-person question.
      type Trip = (typeof board.days)[number]['stops'][number] & { date: string };
      const trips: Trip[] = [];
      const dayRows = new Map<string, { visits: number; completed: number; unassigned: number; byTechnician: Record<string, number> }>();
      for (const day of board.days) {
        const seen = new Set<string>();
        const row = { visits: 0, completed: 0, unassigned: 0, byTechnician: {} as Record<string, number> };
        for (const lane of day.stops) {
          if (lane.technicianRef) {
            row.byTechnician[lane.technicianRef] = (row.byTechnician[lane.technicianRef] ?? 0) + 1;
          }
          if (seen.has(lane.visitId)) continue;
          seen.add(lane.visitId);
          row.visits += 1;
          if (lane.status === 'completed') row.completed += 1;
          if (lane.unassigned) row.unassigned += 1;
          trips.push({ ...lane, date: day.date });
        }
        dayRows.set(day.date, row);
      }
      // Every day of the range, including days with nothing booked — "which days
      // are empty?" needs the zeros to be data, not absences (the board returns
      // only days that have stops).
      const days: Array<{ date: string; weekday: string; visits: number; completed: number; unassigned: number; byTechnician: Record<string, number> }> = [];
      for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${toDay}T00:00:00Z`); t += 86_400_000) {
        const date = new Date(t).toISOString().slice(0, 10);
        const row = dayRows.get(date) ?? { visits: 0, completed: 0, unassigned: 0, byTechnician: {} };
        days.push({ date, weekday: weekdayLabel(date), ...row });
      }
      const counts = {
        byDay: Object.fromEntries(days.map((d) => [d.date, d.visits])),
        total: days.reduce((n, d) => n + d.visits, 0),
        completed: days.reduce((n, d) => n + d.completed, 0),
        unassigned: days.reduce((n, d) => n + d.unassigned, 0),
        untimed: untimedCount,
        unscheduledJobs: unscheduled.count,
      };

      let stopsBlock: Record<string, unknown> = {};
      if (wantStops) {
        // NO navigation links, deliberately (user decision 2026-08-03): this is a
        // dispatching view; per-stop links live on get_schedule.
        const stopKey = (s: Trip): string[] => [s.date, s.start.slice(11, 16), s.visitId];
        const listed = trips
          .filter((s) => technicianRef === undefined || s.technicianRefs.includes(technicianRef))
          .sort((a, b) => compareKeys(stopKey(a), stopKey(b)));
        const { page, next } = keysetPage(listed, stopKey, after ? after.split('|') : null, STOPS_PAGE);
        stopsBlock = {
          stops: page.map((s) => ({
            visitId: s.visitId,
            date: s.date,
            weekday: weekdayLabel(s.date),
            // The lifecycle in one word, v_schedule.stage's vocabulary.
            stage: s.status === 'completed' ? 'happened' : 'placed',
            // Wall-clock HH:MM slices, never the raw timestamptz: times are
            // stored naive-local, so the wire's '+00:00' is a LIE the agent
            // would act on (live 2026-07-22).
            startTime: s.start.slice(11, 16),
            endTime: s.end.slice(11, 16),
            status: s.status,
            technicianRef: s.technicianRefs[0] ?? null,
            technicianName: s.technicianNames[0] ?? null,
            technicianRefs: s.technicianRefs,
            technicianNames: s.technicianNames,
            unassigned: s.unassigned,
            customer: s.customer,
            address: s.address,
            jobId: s.jobId,
            jobTitle: s.jobTitle,
          })),
          hasMore: next !== null,
          next,
          stopsNote:
            `${listed.length} visit(s) match; this page shows ${page.length}. ` +
            (next
              ? 'For the next page call again with the same from/to, stops:true' +
                (technicianRef !== undefined ? `, technicianRef '${technicianRef}'` : '') +
                ' and after = next.'
              : 'That is all of them.'),
        };
      }
      return {
        status: 'ok',
        from,
        to: toDay,
        scheduleVersion,
        technicianHorizonDays,
        days,
        counts,
        countsNote:
          (technicianRef !== undefined
            ? `counts and days[].visits are the WHOLE TEAM's, not ${technicianRef}'s — for one ` +
              "person's number read days[].byTechnician['" + technicianRef + "']. "
            : '') +
          'These counts are computed here — ALWAYS use them for how-many/busiest/compare questions, ' +
          'never count anything yourself. days[].visits counts trips (a crew of two is one visit); ' +
          'byTechnician counts each person on it. 0 visits = nothing booked that day, which is not ' +
          'the same as free — find_slots answers that. counts.untimed are visits committed with NO ' +
          'time set: they sit on no day — never say one is "on" a date; list them with ' +
          'unassignedOnly:true. The range is capped at 14 days: to look further ahead, call again ' +
          'starting where this range ended.',
        ...(wantStops
          ? stopsBlock
          : { note: 'Counts only. For who is going where, call again with stops:true (and technicianRef for one person).' }),
        ...(unscheduled.rowCapHit ? { rowCapNote: rowCapNote('open jobs') } : {}),
      };
}

async function handleBookVisit(toolCtx: ToolContext): Promise<unknown> {
  const { args, identity, tenantId, str, strArray } = toolCtx;
      const subjectRef = identity.technicianRef;
        // resolveBooking runs every dry check (tenant guards, technician
        // resolution, time validation, overlap pre-check) and throws on
        // anything that would make the booking impossible, before anything is
        // written; since rung 9a the booking then commits in the same call.
        // technicianRef is OPTIONAL: omitted = an unassigned booking ("on the
        // calendar, assign later" — attach someone later with move_visit).
        const technicianRef = str('technicianRef');
        // A PRESENT-but-empty ref is an error, not an unassigned booking: the
        // agent named nobody by accident ("book Jane" with the value dropped).
        // Only a genuinely absent key means "assign later" on purpose.
        if (args.technicianRef !== undefined && !technicianRef) {
          throw new Error(
            'technicianRef was empty — pass the roster ref, or omit the field entirely to book unassigned',
          );
        }
        // The CREW (rung 9c). A present-but-EMPTY array is the same accident as
        // an empty ref: the agent meant to name people and the value dropped.
        const technicianRefs = strArray('technicianRefs');
        if (technicianRefs !== undefined && technicianRefs.length === 0) {
          throw new Error(
            'technicianRefs was empty — list every technician going, or omit the field entirely ' +
              'to book unassigned',
          );
        }

        const date = str('date');

        // No default times exist (user decision 2026-07-18): a booking carries
        // exactly the times the manager stated, or it doesn't happen yet. The
        // ONE exception (plan 4b-2, re-cut by rung 9a) is a booking with NO
        // date and NO times — a visit that is committed but not scheduled.
        // Mixing the shapes is always an agent error.
        const startTime = str('startTime');
        const endTime = str('endTime');
        // Non-string args are refused BEFORE the untimed test (the
        // get_team_schedule / find_slots guard idiom): `str()` maps a number
        // to undefined, so {date: 20261119} would otherwise slip through as a
        // deliberate untimed booking instead of failing loudly.
        for (const key of ['date', 'startTime', 'endTime'] as const) {
          if (args[key] !== undefined && typeof args[key] !== 'string') {
            throw new Error(`${key} must be a string (YYYY-MM-DD or HH:MM), not ${typeof args[key]}`);
          }
        }
        // UNTIMED IS SOMETHING YOU SAY, NOT SOMETHING YOU OMIT (rung 10b.2).
        // It used to be `!date && !startTime && !endTime` — so leaving the day
        // out WAS the instruction to book without one, and a day the manager
        // actually stated could vanish with nothing to notice it. Live specimen
        // 2026-09-08: the manager said "Thursday morning", the seat booked
        // untimed, and its own reply named Thursday 2026-09-10 in the next
        // breath. The tool's prose already forbade that ("booking untimed is
        // never your own choice when a day or time was stated") and lost to the
        // schema, which is the shape this whole rung is about.
        if (args.untimed !== undefined && typeof args.untimed !== 'boolean') {
          throw new Error(`untimed must be true or false, not ${typeof args.untimed}`);
        }
        const untimed = args.untimed === true;
        // Contradiction: fail LOUDLY rather than silently preferring one. An
        // agent that passes both has two different intentions in one call, and
        // guessing which it meant is how a stated day gets dropped.
        if (untimed && (date || startTime || endTime)) {
          throw new Error(
            'untimed:true means NO day and no times — you passed some. Either book it on the ' +
              'day you were given (date + startTime + endTime), or drop those and book untimed.',
          );
        }
        if (!untimed && (!date || !startTime || !endTime)) {
          throw new Error(
            'date, startTime and endTime are required TOGETHER — the server assumes no default ' +
              'day or length. If the manager did not say when the visit starts or ends, ASK ' +
              'them, then book. Only if they said the timing is not settled at all, pass ' +
              '`untimed: true` — never leave the day out to mean that, and never drop a day ' +
              'you were given.',
          );
        }
        const customerId = str('customerId');
        const jobId = str('jobId');
        const priorityArg = str('priority');
        if (priorityArg && !JOB_PRIORITIES.includes(priorityArg as JobPriority)) {
          throw new Error(`invalid priority: ${priorityArg}`);
        }
        // Silently dropping it would let the agent report an urgency that was
        // never stored — refuse instead (an existing job keeps its priority).
        if (priorityArg && jobId) {
          throw new Error(
            'priority applies when a new job is created (customerId path) — this booking uses an existing job, which keeps its recorded priority',
          );
        }
        // RUNG 10 — CITE THE CALL THIS BOOKING ANSWERS. Resolved BEFORE the
        // write so the stamp lands on the rows themselves rather than needing
        // a second update; null on the ordinary booking nobody phoned in about.
        const ask = await inboundAskFor(tenantId, {
          ...(jobId ? { jobId } : {}),
          ...(customerId && !jobId ? { customerId } : {}),
        });
        // ONE input literal for both paths — a field added here reaches the
        // one-shot commit and the staged preview identically.
        const bookInput = {
          tenantId,
          ...(ask ? { sourceCaptureId: ask.captureId } : {}),
          ...(technicianRef ? { technicianRef } : {}),
          ...(technicianRefs ? { technicianRefs } : {}),
          ...(customerId ? { customerId } : {}),
          ...(jobId ? { jobId } : {}),
          title: str('title') ?? null,
          ...(date ? { date } : {}),
          ...(startTime ? { startTime } : {}),
          ...(endTime ? { endTime } : {}),
          ...(priorityArg ? { priority: priorityArg as JobPriority } : {}),
          ...(args.forceNewJob === true ? { forceNewJob: true } : {}),
          actorRef: subjectRef,
        };
        // Doctrine (user decision 2026-07-17, single-sourced in booking.ts):
        // nothing promised = internal + reversible → ONE step. For a book the
        // verdict is input-derived, so no preview round is needed — bookVisit
        // runs every guard itself (one resolution instead of two).
          const booked = await bookVisit(bookInput);
          // WHAT THE CALLER SAID, ONTO THE JOB THIS CALL OPENED. Only when the
          // booking MINTED the job: on the jobId path the job already exists and
          // the write path put the caller's words on it when the capture landed.
          // Advisory — a booking that happened is a booking, and the words are
          // still in L1 and in the observation either way.
          if (ask && !jobId) {
            try {
              await appendJobCorrespondence(
                booked.job.id,
                correspondenceOf(ask.captureId, ask.channel, ask.capturedAt, {
                  followUp: ask.followUp ?? null,
                  attributes: ask.attributes ?? null,
                }),
              );
            } catch (err) {
              console.error(
                `book_visit: job ${booked.job.id} was booked, but the caller's words were not ` +
                  'copied onto it',
                err,
              );
            }
          }
          return {
            status: 'booked',
            visitId: booked.assignment.id,
            jobId: booked.job.id,
            // The job's identity rides EVERY booked result: the title is
            // agent-supplied free text on the customerId path, and without
            // this echo an assumed title ("drainage replacement") reached the
            // permanent record without ever being said to the manager (live
            // E2E finding 2026-07-21). Echo → the manager hears the
            // assumption in the same breath it is made.
            jobTitle: booked.job.title,
            customer: booked.customer.name,
            // Pre-composed weekday+date — SAY THIS VERBATIM when naming the
            // day (weekday-mismatch class; see servedDayPhrase).
            ...(booked.assignment.starts_at
              ? { dayPhrase: servedDayPhrase(booked.assignment.starts_at.slice(0, 10)) }
              : {}),
            technicianRef: booked.technicianRefs[0] ?? null,
            // EVERYBODY who is going. A one-person booking still carries the
            // list, so a surface never has to guess which field to read.
            technicianRefs: booked.technicianRefs,
            ...(booked.technicianRefs.length > 1
              ? {
                  crewNote:
                    `${booked.technicianRefs.length} people are on this visit — it is ONE trip, ` +
                    'not one each. Name all of them when you report it.',
                }
              : {}),
            unassigned: booked.technicianRefs.length === 0,
            // ROW-derived, never the input, so the echo can never name a day
            // the row does not hold (final-review finding). Null on an untimed
            // booking — there is no day, and inventing one is the whole class
            // of error this rung removes.
            date: booked.assignment.starts_at?.slice(0, 10) ?? null,
            // Resolved times from the row itself (naive-local, exact slices).
            startTime: booked.assignment.starts_at?.slice(11, 16) ?? null,
            endTime: booked.assignment.ends_at?.slice(11, 16) ?? null,
            ...(booked.assignment.starts_at === null ? { untimed: true } : {}),
            jobPriority: booked.job.priority,
            // Same silent-stored-value rule as jobTitle (final-review finding):
            // a customerId-path booking mints a shell that RECORDS the booked
            // span as the job's length — a value that drives every later
            // find_slots, so it must be said in the same breath it is stored.
            jobDurationMinutes: booked.job.duration_minutes,
            ...(booked.warning ? { warning: booked.warning } : {}),
            note:
              'Booked in one step (undo = move_visit / unschedule_visit). ' +
              'Tell the manager exactly what ' +
              'was booked: the JOB (jobTitle above — their words to object to if you assumed ' +
              'it), customer, day, time, and who. An `untimed` result has NO day and NO time — ' +
              'say exactly that ("booked, no time set yet"), never a guess; it waits in the ' +
              'unscheduled queue and a move_visit with real times places it. ' +
              'On a new job the booked span is stored as ' +
              "the job's length (jobDurationMinutes) — mention it; update_job corrects it.",
          };
}

async function handleMoveVisit(toolCtx: ToolContext): Promise<unknown> {
  const { args, identity, tenantId, str, strArray } = toolCtx;
      const subjectRef = identity.technicianRef;
        // previewMoveVisit throws on impossible moves before anything is
        // written; since rung 9a the move then commits in the same call.
        const visitId = str('visitId');
        const date = str('date');
        const startTime = str('startTime');
        const reason = str('reason')?.trim();
        if (!visitId) throw new Error('visitId is required');
        if (!date || !startTime) throw new Error('date and startTime are required');
        if (!reason) throw new Error('reason is required — say why the visit is moving');
        const technicianRefArg = str('technicianRef');
        const technicianRefsArg = strArray('technicianRefs');
        if (technicianRefsArg !== undefined && technicianRefsArg.length === 0) {
          throw new Error(
            'technicianRefs was empty — list the crew AFTER the move, or pass unassign:true to ' +
              'take everyone off',
          );
        }
        if (args.unassign !== undefined && typeof args.unassign !== 'boolean') {
          throw new Error('unassign must be a boolean');
        }
        const unassignArg = args.unassign === true;
        if (unassignArg && (technicianRefArg || technicianRefsArg)) {
          throw new Error(
            'pass technicianRef/technicianRefs to attach or reassign, OR unassign:true to park ' +
              'the visit — not both',
          );
        }
        const preview = await previewMoveVisit({
          tenantId,
          visitId,
          date,
          startTime,
          ...(str('endTime') ? { endTime: str('endTime') } : {}),
          ...(technicianRefArg ? { technicianRef: technicianRefArg } : {}),
          ...(technicianRefsArg ? { technicianRefs: technicianRefsArg } : {}),
          unassign: unassignArg,
          reason,
          actorRef: subjectRef,
        });
        // Doctrine (2026-07-17, re-cut by rung 9a): a move is internal and
        // reversible, so it happens in ONE step and is reported. Nothing in
        // the schema records what a customer was told any more — the agent is
        // expected to have READ the job's record for promises BEFORE moving,
        // and this tool cannot and must not claim none existed.
          const moved = await moveVisit({
            tenantId,
            visitId,
            date,
            startTime,
            endTime: preview.endTime, // resolved — preview == commit
            ...(technicianRefArg ? { technicianRef: technicianRefArg } : {}),
            ...(technicianRefsArg ? { technicianRefs: technicianRefsArg } : {}),
            unassign: unassignArg,
            reason,
            actorRef: subjectRef,
          });
          return {
            status: 'moved',
            // The SAME id it had before the move (rung 9b): a visit is one
            // object for its whole life, so a link or a gap that named it
            // still names it.
            visitId: moved.visit.id,
            stage: stageOf(moved.visit, false),
            date,
            ...(date ? { dayPhrase: servedDayPhrase(date) } : {}),
            startTime,
            endTime: preview.endTime,
            // Who is on it AFTER the move, read back from the row itself.
            technicianRefs: moved.technicianRefs,
            ...(moved.technicianRefs.length > 1
              ? {
                  crewNote:
                    `${moved.technicianRefs.length} people are on this visit — it is ONE trip, ` +
                    'not one each. Name all of them when you report it.',
                }
              : {}),
            ...(moved.crewNotAdded.length > 0
              ? {
                  crewNotAdded: moved.crewNotAdded,
                  crewNotAddedNote:
                    'The visit DID move, but these people are booked elsewhere at the new time ' +
                    'and are NOT on it. Say both halves to the manager.' +
                    (moved.technicianRefs.length === 0
                      ? ' NOBODY is on this visit now — it moved and it is unassigned. Say that ' +
                        'plainly and ask the manager who should go.'
                      : ''),
                }
              : {}),
            // CREW-DERIVED, not "did the caller say unassign" (rung 9c): a move
            // whose joiner was lost to a race can land a trip with nobody on it,
            // and the agent has to be able to see that.
            ...(moved.technicianRefs.length === 0 ? { unassigned: true } : {}),
            ...(moved.warning ? { warning: moved.warning } : {}),
            note: unassignArg
              ? 'Parked in one step — the person was taken off; the visit keeps its slot and ' +
                'now shows under Unassigned (board) / unassignedOnly (get_team_schedule). ' +
                'Tell the manager exactly what happened.'
              : 'Moved in one step. Tell the manager exactly what moved. If the customer was ' +
                'told a day or time for this visit, THEY still need telling — check the job\'s ' +
                'record (calls, emails, notes) before you move a visit, not after.',
          };
}

async function handleUnscheduleVisit(toolCtx: ToolContext): Promise<unknown> {
  const { identity, tenantId, str } = toolCtx;
      const subjectRef = identity.technicianRef;
      const confirmId = str('confirmId');
      if (!confirmId) {
        // STAGE.
        const visitId = str('visitId');
        const reason = str('reason')?.trim();
        if (!visitId) throw new Error('visitId is required');
        if (!reason) throw new Error('reason is required — say why the visit is being unscheduled');
        // WHAT IS BEING APPROVED is this visit at THIS time. Moves keep the id
        // (rung 9b), so the yes re-checks the time against this snapshot. Read
        // BEFORE the preview: a move landing between the two reads then refuses
        // at the yes instead of becoming the approved time.
        const snapshot = await getVisitForTenant(visitId, tenantId);
        const preview = await previewUnscheduleVisit(tenantId, visitId);
        // Doctrine (2026-07-17, verdict computed in booking.ts): cancelling an
        // UNPROMISED visit is internal + reversible (the job stays open;
        // rebook any time) → one step. Cancelling a promised visit stages —
        // the customer expects someone, and the manager must own telling them.
        if (!preview.requiresConfirmation) {
          const cancelledRow = await unscheduleVisit({
            tenantId,
            visitId,
            reason,
            actorRef: subjectRef,
          });
          return {
            status: 'unscheduled',
            visitId: cancelledRow.id,
            // Placed day, else the unplaced range's day (plan 4b-2).
            day: cancelledRow.starts_at?.slice(0, 10) ?? null,
            note:
              'Unscheduled in one step — this visit had no time set, so nobody was holding an ' +
              'appointment for it. The WORK is not cancelled: the job is back in the loose ' +
              'bucket for rebooking; tell the manager exactly that.',
          };
        }
        // Staging replaces any prior staged cancel; one-shot cancels above
        // leave pending tokens alone.
        await resolveOpenReviewItemFor(
          tenantId,
          'pending_visit_cancel',
          subjectRef,
          'dismissed',
          'superseded by a new cancel request',
        );
        const item = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_visit_cancel',
          subjectRef,
          detail: {
            visitId,
            reason,
            preview: preview as unknown as Json,
            // Wall-clock slices, never the raw column: list_pending_reviews
            // handed this detail to the model until it was retired
            // (2026-09-19), and wall-clock stays the rule for anything a model
            // may read — raw `+00:00` timestamps there were the 2026-07-22
            // defect (see get_team_schedule's note).
            expected: {
              startsAt: wallClock(snapshot?.starts_at),
              endsAt: wallClock(snapshot?.ends_at),
            },
            stagedAt: new Date().toISOString(),
          } as unknown as Json,
        });
        const staged = (item.detail ?? {}) as { preview?: unknown };
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          preview: staged.preview ?? preview,
          note: 'Nothing was unscheduled. Show the manager exactly this preview; on their explicit yes call again with ONLY confirmId.',
        };
      }
      // CONFIRM — consume-first.
      const item = await getOpenReviewItem(confirmId, tenantId, {
        kind: 'pending_visit_cancel',
        subjectRef,
      });
      if (!item) {
        throw new Error('confirmation not found — call unschedule_visit again with visitId + reason to restage');
      }
      const d = (item.detail ?? {}) as {
        visitId?: string;
        reason?: string;
        stagedAt?: string;
        expected?: { startsAt?: string | null; endsAt?: string | null };
      };
      if (d.stagedAt && Date.now() - Date.parse(d.stagedAt) > 15 * 60_000) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'confirmation expired');
        throw new Error('confirmation expired — restage the unschedule and confirm again');
      }
      if (!d.visitId || !d.reason) {
        throw new Error('staged unschedule is malformed — restage with visitId + reason');
      }
      // The yes approved THIS visit at the staged time. If it moved, lost its
      // time, or is gone, cancelling now would cancel something nobody saw.
      // Checked HERE so a refusal dismisses the token before it is consumed; the
      // cancel below repeats the check atomically (unscheduleVisit's
      // `expectedTimes`), because a move can still land between this read and
      // the update.
      const expected = d.expected;
      if (!expected || expected.startsAt === undefined) {
        // Staged before the snapshot existed: fail closed, the 15-minute window bounds it.
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'staged before the time check existed');
        throw new Error('this confirmation predates a safety check — nothing was cancelled; restage the unschedule and confirm again');
      }
      const now = await getVisitForTenant(d.visitId, tenantId);
      if (!now) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'visit no longer found');
        throw new Error('visit NOT unscheduled: it no longer exists for this firm — nothing was cancelled');
      }
      if (wallClock(now.starts_at) !== expected.startsAt || wallClock(now.ends_at) !== expected.endsAt) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'visit moved while the confirmation was pending');
        throw new Error(
          'visit NOT unscheduled: it moved (or lost its time) since the manager approved — nothing was ' +
            'cancelled; restage to see its current time',
        );
      }
      const consumed = await resolveReviewItem(
        item.id,
        tenantId,
        'resolved',
        `unschedule confirmed by ${subjectRef}`,
      );
      if (!consumed) {
        throw new Error('already confirmed or cancelled — nothing was changed by this call');
      }
      let cancelledRow;
      try {
        cancelledRow = await unscheduleVisit({
          tenantId,
          visitId: d.visitId,
          reason: d.reason,
          actorRef: subjectRef,
          // The approved times, enforced on the UPDATE itself: a move landing
          // after the check above makes the cancel match no row.
          expectedTimes: { startsAt: now.starts_at, endsAt: now.ends_at },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await annotateResolvedReviewItem(
            confirmId,
            tenantId,
            `confirmed but unschedule FAILED (${msg}) — the visit is unchanged`,
          );
        } catch {
          /* advisory */
        }
        throw new Error(`visit NOT unscheduled: ${msg}`);
      }
      return {
        status: 'unscheduled',
        visitId: cancelledRow.id,
        // Placed day, else the unplaced range's day (plan 4b-2).
        day: cancelledRow.starts_at?.slice(0, 10) ?? null,
        note: 'the work is not cancelled — the job is back in the loose bucket for rebooking',
      };
}

async function handleSetAvailability(toolCtx: ToolContext): Promise<unknown> {
  const { args, identity, tenantId, str } = toolCtx;
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      const target = await resolveScheduleInputTarget(tenantId, ref);
      if (
        typeof args.pattern !== 'object' ||
        args.pattern === null ||
        Array.isArray(args.pattern)
      ) {
        throw new Error(
          'pattern must be a JSON object with all 7 day keys mon..sun — see the tool description example',
        );
      }
      // assertValidPattern (inside the setter) owns the deep validation and
      // throws actionable per-field errors the agent can relay verbatim.
      const updated = await setTechnicianAvailability(
        target.id,
        args.pattern as WeeklyPattern,
      );
      // The onboarding obligation is met — close the availability_setup item
      // if one is open (rows predating the hook simply have none).
      await resolveOpenReviewItemFor(
        tenantId,
        'availability_setup',
        ref,
        'resolved',
        `pattern configured by ${identity.technicianRef}`,
      );
      const stored = updated.availability as WeeklyPattern;
      const dayWords = WEEK_DAYS.map((d) => {
        const wins = stored[d];
        return `${d}: ${wins.length === 0 ? 'off' : wins.map(([s, e]) => `${s}–${e}`).join(', ')}`;
      }).join('; ');
      return {
        status: 'ok',
        ref,
        pattern: stored,
        note:
          `${target.display_name}'s working pattern is set (${dayWords}). ` +
          'They are now visible to the scheduler on their working days. Tell the manager exactly this.',
      };
}

async function handleGetAvailability(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str } = toolCtx;
      // The read half of set_availability. Until 2026-08-04 the pattern was
      // write-only: list_team exposed `availabilityConfigured` (a boolean) and
      // nothing returned the pattern itself, so "what is Joy's availability?"
      // had no answer — a live turn burned 106s and 14 calls failing to find one.
      const ref = str('ref');
      const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
      const todayLocal = localDateISO(new Date().toISOString(), tz);
      // A fixed 30-day window: time off matters here only as "what overrides the
      // pattern soon". Anything longer is a schedule question, and that is
      // find_slots' job, not this tool's.
      const windowEnd = localDateISO(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        tz,
      );

      // One tenant-scoped roster read either way; ref only narrows it. Resolving
      // through the roster (rather than trusting ref) keeps the tenant filter on
      // the one query that has it — listTimeOffForTechnician takes no tenantId,
      // so its technician_id MUST come from a tenant-scoped row.
      const roster = await listTeam(tenantId);
      const people = ref
        ? roster.filter((t) => t.ref === ref)
        : roster.filter((t) => t.state === 'active');
      if (ref && people.length === 0) {
        throw new Error(
          `no team member with ref '${ref}' — call list_team to see the roster and use a ref exactly as spelled there`,
        );
      }

      const rows = await Promise.all(
        people.map(async (t) => {
          const timeOff = await listTimeOffForTechnician(t.id, todayLocal, windowEnd);
          const pattern = (t.availability as WeeklyPattern | null) ?? null;
          return {
            ref: t.ref,
            displayName: t.display_name,
            tier: t.tier,
            state: t.state,
            seatExempt: t.seat_exempt,
            configured: pattern !== null,
            summary: summarizeWeeklyPattern(pattern),
            pattern,
            timeOff: timeOff.map((o) => ({
              startsOn: o.starts_on,
              endsOn: o.ends_on,
              reason: o.reason,
            })),
          };
        }),
      );

      // Fused into the result, not left to the description: the live model reads
      // a configured pattern as "free" unless told otherwise, and a manager
      // acting on that double-books someone (the resolve_date lesson again).
      return {
        status: 'ok',
        people: rows,
        note:
          'This is the CONFIGURED working pattern, not free/busy — it does not account for ' +
          'visits already booked. Relay each summary line as written. For what is actually ' +
          'bookable, use find_slots.',
      };
}

async function handleAddTimeOff(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str } = toolCtx;
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      const startsOn = str('startsOn');
      const endsOn = str('endsOn');
      if (!startsOn || !isRealDateISO(startsOn) || !endsOn || !isRealDateISO(endsOn)) {
        throw new Error('startsOn and endsOn must be real YYYY-MM-DD dates');
      }
      if (startsOn > endsOn) throw new Error('startsOn must be on or before endsOn');
      const target = await resolveScheduleInputTarget(tenantId, ref);
      const row = await addTimeOff({
        tenantId,
        technicianId: target.id,
        startsOn,
        endsOn,
        reason: str('reason') ?? null,
      });
      return {
        status: 'ok',
        ref,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
        reason: row.reason,
        note:
          `Time off recorded for ${target.display_name}: ${row.starts_on}` +
          (row.ends_on === row.starts_on ? '' : ` through ${row.ends_on}`) +
          `${row.reason ? ` (${row.reason})` : ''}. The scheduler will skip these days; ` +
          'manual bookings will warn. Tell the manager exactly this.',
      };
}

async function handleRemoveTimeOff(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str } = toolCtx;
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      const date = str('date');
      if (!date || !isRealDateISO(date)) throw new Error('date must be a real YYYY-MM-DD date');
      const target = await resolveScheduleInputTarget(tenantId, ref);
      const overlapping = await listTimeOffForTechnician(target.id, date, date);
      // Report ONLY what this call actually deleted — a range vanishing
      // between list and delete (concurrent removal) is tolerated silently.
      const removed = [];
      for (const row of overlapping) {
        if (await deleteTimeOff(row.id, tenantId)) {
          removed.push({ startsOn: row.starts_on, endsOn: row.ends_on, reason: row.reason });
        }
      }
      return {
        status: 'ok',
        ref,
        removed,
        note:
          removed.length === 0
            ? `${target.display_name} has no time off overlapping ${date} — nothing to remove.`
            : `Removed ${removed.length} time-off range(s) for ${target.display_name}: ` +
              removed.map((r) => `${r.startsOn}–${r.endsOn}`).join(', ') +
              '. Tell the manager exactly this.',
      };
}

async function handleSetJobDuration(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
      const jobType = str('jobType')?.trim();
      // An empty type would mint an unmatchable '' row (untyped jobs carry
      // null, never '') — refuse it.
      if (!jobType) throw new Error('jobType is required and must not be empty');
      if (typeof args.minutes !== 'number' || !Number.isInteger(args.minutes) || args.minutes <= 0) {
        throw new Error('minutes must be a whole number greater than 0');
      }
      const row = await upsertJobTypeDuration(tenantId, jobType, args.minutes);
      return {
        status: 'ok',
        jobType: row.job_type,
        minutes: row.minutes,
        note:
          `'${row.job_type}' jobs are now assumed to take ${row.minutes} minutes when ` +
          'scheduling, unless a different duration is stated for a specific visit. ' +
          'Tell the manager exactly this.',
      };
}

async function handleSetTechnicianHorizon(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId } = toolCtx;
      if (
        typeof args.weeks !== 'number' ||
        !Number.isInteger(args.weeks) ||
        args.weeks < 1 ||
        args.weeks > 12
      ) {
        throw new Error('weeks must be a whole number from 1 to 12');
      }
      // Old value read before the write so the echo is old → new (update_job
      // idiom). Plain update, no CAS — settings row, effectively single-writer
      // (setTenantSeats precedent); the DB CHECK (7-84) backstops range.
      const beforeDays = horizonDaysFor(await getTenant(tenantId));
      const updatedTenant = await setTechnicianHorizonDays(tenantId, args.weeks * 7);
      return {
        status: 'ok',
        changes: {
          technicianHorizonDays: { from: beforeDays, to: updatedTenant.technician_horizon_days },
        },
        note:
          `technicians now see at most ${args.weeks} week(s) — ` +
          `${updatedTenant.technician_horizon_days} days — ahead (was ${beforeDays} days); ` +
          'schedule reads beyond that answer "not published yet". Tell the manager exactly ' +
          'what changed (old → new).',
      };
}

async function handleSetTimezone(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId } = toolCtx;
      // Non-string args are REJECTED, never coerced-to-absent (the find_slots
      // precedent — the SDK does not validate args, and a coerced-away timezone
      // would read as "not supplied" on a required field).
      if (typeof args.timezone !== 'string') {
        throw new Error('timezone must be a string');
      }
      const timezone = args.timezone;
      if (!isValidTimezone(timezone)) {
        throw new Error(
          `not a timezone I recognise: ${JSON.stringify(timezone)}. Use a full IANA name such ` +
            'as "America/Chicago", "America/New_York", "America/Denver", "America/Phoenix" or ' +
            '"America/Los_Angeles" (case matters). A plain city name is not a zone, and an ' +
            'abbreviation like "CST" or "EST" is refused on purpose — several of those never ' +
            'observe daylight saving, so they would read an hour wrong for half the year ' +
            'without anything failing.',
        );
      }
      // Old value read before the write so the echo is old → new (the
      // set_technician_horizon / update_job idiom).
      const before = (await getTenant(tenantId))?.timezone ?? null;
      const updated = await setTenantTimezone(tenantId, timezone);
      // The clock is what the manager can actually verify. spineNowIso keeps
      // the date-eval's EVAL_FAKE_NOW anchoring working here too, so a probe
      // run does not read the wall clock.
      const localTime = new Intl.DateTimeFormat('en-US', {
        timeZone: updated.timezone,
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(spineNowIso(tenantId)));
      return {
        status: 'ok',
        changes: { timezone: { from: before, to: updated.timezone } },
        localTime,
        note:
          `the firm's timezone is now ${updated.timezone} (was ${before ?? 'unset'}); ` +
          `it is ${localTime} there right now. Read the TIME back to the manager and ask if ` +
          'that is right — do not ask them to confirm the zone name.',
      };
}

async function handleFindSlots(toolCtx: ToolContext): Promise<unknown> {
  const { args, deps, tenantId, str } = toolCtx;
      // Non-string args are REJECTED, never coerced-to-absent: str() maps
      // {technicianRef: 123} to undefined, which would silently UN-PIN the
      // search (the get_schedule precedent — the SDK doesn't validate args).
      for (const k of ['customerId', 'jobId', 'visitId', 'technicianRef', 'assumedType']) {
        if (args[k] !== undefined && typeof args[k] !== 'string') {
          throw new Error(`${k} must be a string`);
        }
      }
      // ------- subject: exactly one of customerId | jobId | visitId
      const customerIdArg = str('customerId');
      const jobIdArg = str('jobId');
      const visitIdArg = str('visitId');
      if ([customerIdArg, jobIdArg, visitIdArg].filter(Boolean).length !== 1) {
        throw new Error('pass exactly one of customerId, jobId, or visitId');
      }
      const pinnedRef = str('technicianRef');
      const assumedType = str('assumedType')?.trim().toLowerCase();
      // Same bound as every duration write surface (final-review finding: the
      // typo 6000-for-600 that update_job refuses must not sail through here
      // into a 100-hour slot search that answers "nothing fits").
      if (args.durationMinutes !== undefined && !isValidDuration(args.durationMinutes)) {
        throw new Error(durationError());
      }
      const statedMinutes = args.durationMinutes as number | undefined;
      if (
        args.requiredSkills !== undefined &&
        (!Array.isArray(args.requiredSkills) ||
          args.requiredSkills.some((s) => typeof s !== 'string'))
      ) {
        throw new Error('requiredSkills must be an array of strings');
      }
      const requiredSkills = (args.requiredSkills as string[] | undefined)
        ?.map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      // ------- resolve the subject rows (tenant-guarded)
      let job: Job | null = null;
      let subjectRow: {
        id: string;
        starts_at: string | null; // null = UNTIMED (plan 4b-2, rung 9a)
        ends_at: string | null;
        status: string;
      } | null = null;
      // Who is on the subject trip, if it has anybody (rung 9c).
      let subjectCrewIds: string[] = [];
      let customerIdResolved: string;
      if (visitIdArg) {
        const row = await getVisitForTenant(visitIdArg, tenantId);
        if (!row) throw new Error('visit not found');
        // Mirror move/cancel's subject rule: terminal rows are history, not
        // schedulable subjects.
        if (row.status !== 'confirmed' && row.status !== 'proposed') {
          throw new Error(`this visit is ${row.status} — only confirmed or proposed visits can be re-placed`);
        }
        subjectRow = row;
        // The crew comes off the participant table, not the row: `visits` no
        // longer knows who is on a trip (rung 9c).
        subjectCrewIds = (await listParticipants(row.id)).map((p) => p.technician_id);
        const j = await getJob(row.job_id);
        if (!j || j.tenant_id !== tenantId) throw new Error('visit job not found');
        job = j;
        customerIdResolved = j.customer_id;
      } else if (jobIdArg) {
        const j = await getJob(jobIdArg);
        if (!j || j.tenant_id !== tenantId) throw new Error('job not found');
        job = j;
        customerIdResolved = j.customer_id;
      } else {
        customerIdResolved = customerIdArg as string;
      }
      const customer = await getCustomer(customerIdResolved);
      if (!customer || customer.tenant_id !== tenantId) throw new Error('customer not found');

      // The customerId MINT GUARD (mirrors book_visit, message single-sourced
      // in booking.ts): a customerId subject describes a hypothetical NEW job
      // — the recurring live failure is searching (then booking) by customerId
      // for work already on file, which is also where every baffling "no
      // recorded type" error came from. Steer to the real jobId instead.
      if (!jobIdArg && !visitIdArg && args.forceNewJob !== true) {
        const openWork = await listOpenJobsForCustomer(customer.id);
        if (openWork.length > 0) throw new Error(openWorkSteer('searched', openWork));
      }

      // ------- duration: fail-closed, disclosed, never invented
      // The configured vocabulary rides in every no-duration error so the
      // AGENT does the language-level mapping with the choices in hand — the
      // server never fuzzy-matches (a wrong match silently books a wrong-
      // length job).
      // Since 4b-1 the PRIMARY remedy is the job's own durationMinutes
      // (update_job): ask the manager, offer the ladder, take any whole
      // number. The type routes remain as secondary paths.
      // typedJob variant matters: assumedType is REFUSED for jobs that already
      // carry a type, so advising it there would send the agent into a
      // two-error loop (review finding) — a typed job's remedies are the job's
      // own duration, the type's stored duration, a one-off durationMinutes,
      // or correcting the type.
      const ladderOffer =
        'ask the manager how long this job takes and set it with update_job ' +
        `(durationMinutes — offer ${DURATION_LADDER.join('/')}; any whole number works)`;
      const vocabularyGuidance = async (typedJob: boolean): Promise<string> => {
        const rows = await listJobTypeDurations(tenantId);
        const remedy = typedJob
          ? `${ladderOffer}; or store this type's duration with set_job_duration, pass ` +
            'durationMinutes (one-off), or correct a wrong type with update_job'
          : `${ladderOffer}; if this job is one of those types, call again with assumedType ` +
            'set to that type; a one-off durationMinutes also works, and set_job_duration ' +
            'stores a type rule for recurring work';
        return rows.length > 0
          ? `Configured types: ${rows.map((r) => `${r.job_type} (${r.minutes}m)`).join(', ')}. ` +
              remedy.charAt(0).toUpperCase() +
              remedy.slice(1) +
              '.'
          : `No job-type durations are configured yet — ${
              typedJob
                ? `${ladderOffer}; pass durationMinutes (one-off), set_job_duration, or ` +
                  'correct the type with update_job'
                : `${ladderOffer}, pass durationMinutes (one-off), or store a type rule with ` +
              'set_job_duration for recurring work'
            }.`;
      };
      // A job row that already carries a type is AUTHORITATIVE — agent
      // classification applies only to untyped jobs; overriding a typed job's
      // duration takes the explicit durationMinutes arg, nothing softer.
      if (assumedType && job?.job_type) {
        throw new Error(
          `this job already has type '${job.job_type}' — its stored duration applies; ` +
            'to use a different length, pass durationMinutes',
        );
      }
      let durationMin: number;
      let durationAssumption: string | undefined;
      let assumedTypeNote: string | undefined;
      if (statedMinutes !== undefined) {
        durationMin = statedMinutes;
        // Overriding ANY stored value is disclosed — and the counterfactual
        // must name what WOULD have applied, so this order mirrors the
        // resolution chain below: the job's own length outranks the type
        // default (final-review finding: checking job_type first told the
        // manager they overrode a type duration the chain would never have
        // used on a job that carries its own length).
        if (job?.duration_minutes) {
          durationAssumption =
            `using your stated ${formatDuration(durationMin)} for this visit — not this ` +
            `job's recorded length (${formatDuration(job.duration_minutes)})`;
        } else if (job?.job_type) {
          durationAssumption =
            `using your stated ${formatDuration(durationMin)} for this visit — not the stored ` +
            `'${job.job_type}' duration`;
        }
      } else if (subjectRow && subjectRow.starts_at !== null && subjectRow.ends_at !== null) {
        // An existing visit's booked length is a real value — no assumption.
        // Same refusal rule as the own-length branch below (round-2 review):
        // the duration is KNOWN here, so assumedType would ride every reason
        // string unvetted while contributing nothing.
        if (assumedType) {
          throw new Error(
            "this visit's booked length applies — to use a different length, pass " +
              'durationMinutes (assumedType only resolves an unknown duration)',
          );
        }
        durationMin = spanMinutes(subjectRow.starts_at, subjectRow.ends_at);
        durationAssumption = `using this visit's booked length (${formatDuration(durationMin)})`;
      } else if (subjectRow && job?.duration_minutes) {
        // UNPLACED subject (plan 4b-2): no booked span exists — the job's own
        // recorded length (4b-1) is the honest stand-in. Same assumedType
        // refusal as every known-duration branch.
        if (assumedType) {
          throw new Error(
            `this job has a recorded length (${formatDuration(job.duration_minutes)}) — its own ` +
              'value applies; to use a different length, pass durationMinutes',
          );
        }
        durationMin = job.duration_minutes;
        durationAssumption = `this visit has no time yet — using the job's recorded length (${formatDuration(durationMin)})`;
      } else if (job?.duration_minutes) {
        // The job's OWN length (plan 4b-1) outranks the type lookup: a stored
        // per-job value — manager-stated or booking-measured — is more specific
        // than a per-type default. Also a real value, so no fail-closed error.
        // assumedType is REFUSED here (final-review finding): its job is
        // resolving an UNKNOWN duration, and this one is known — accepting it
        // would brand every reason string with an unvetted type (the lookup
        // that validates it never runs on this branch) while the minutes come
        // from somewhere else entirely. Mirrors the typed-job refusal above.
        if (assumedType) {
          throw new Error(
            `this job has a recorded length (${formatDuration(job.duration_minutes)}) — its own ` +
              'duration applies; to use a different length, pass durationMinutes ' +
              '(assumedType only resolves an unknown duration)',
          );
        }
        durationMin = job.duration_minutes;
        durationAssumption = `using this job's recorded length (${formatDuration(durationMin)})`;
      } else {
        const lookupType = job?.job_type?.trim().toLowerCase() || assumedType;
        if (!lookupType) {
          throw new Error(`this job has no recorded type. ${await vocabularyGuidance(false)}`);
        }
        const stored = await findJobTypeDurationMinutes(tenantId, lookupType);
        if (stored === null) {
          throw new Error(
            `no duration is configured for '${lookupType}'. ${await vocabularyGuidance(Boolean(job?.job_type))}`,
          );
        }
        durationMin = stored;
        durationAssumption =
          `assuming ${stored} min for '${lookupType}' (from your set_job_duration setting) ` +
          '— pass durationMinutes if this job differs';
      }
      // The guess label rides on EVERY untyped-subject use of assumedType —
      // durationLabel fuses the type into each reason string regardless of
      // where the minutes came from (review finding #5: an assumedType +
      // durationMinutes combination must not escape disclosure).
      if (assumedType && !job?.job_type) {
        assumedTypeNote =
          `'${assumedType}' is YOUR reading of ` +
          (job ? `'${job.title}'` : 'this request') +
          ' — present it to the manager as a guess ("treating this as ' +
          `${assumedType} — say otherwise")`;
      }
      const durationLabel = `${formatDuration(durationMin)} ${job?.job_type ?? assumedType ?? 'visit'}`;

      // ------- date range (get_team_schedule idiom: informative, not thrown)
      const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
      const nowISO = new Date().toISOString();
      const todayISO = localDateISO(nowISO, tz);
      // find_slots' earliestDate/latestDate are a SEARCH RANGE — "look between
      // these dates" — never a commitment, which is why they survive rung 9a
      // untouched while the stored window dies. An untimed subject no longer
      // carries days of its own to default from, so every subject now gets the
      // same today-forward default and explicit args still override.
      const earliestArg = str('earliestDate');
      const latestArg = str('latestDate');
      const earliest = earliestArg ?? todayISO;
      const latest = latestArg ?? addDaysISO(todayISO, 13);
      // Non-string range args → invalid_range, not a silent default window
      // (mirrors get_team_schedule's guard).
      if (
        (args.earliestDate !== undefined && typeof args.earliestDate !== 'string') ||
        (args.latestDate !== undefined && typeof args.latestDate !== 'string')
      ) {
        return {
          status: 'invalid_range',
          note: 'earliestDate/latestDate must be YYYY-MM-DD strings',
        };
      }
      const DATE = /^\d{4}-\d{2}-\d{2}$/;
      if (!DATE.test(earliest) || !DATE.test(latest) || earliest > latest) {
        return {
          status: 'invalid_range',
          note: 'earliestDate/latestDate must be YYYY-MM-DD with earliest <= latest',
        };
      }
      // Parseability BEFORE the clamps below — addDaysISO throws on a
      // regex-passing garbage date ('2026-02-31'), and garbage must stay an
      // invalid_range, never an exception.
      if (
        !Number.isFinite(Date.parse(`${earliest}T00:00:00Z`)) ||
        !Number.isFinite(Date.parse(`${latest}T00:00:00Z`))
      ) {
        return { status: 'invalid_range', note: 'earliestDate/latestDate is not a real calendar date' };
      }
      if (latest < todayISO) {
        return {
          status: 'invalid_range',
          note: `the whole range is in the past (today is ${todayISO}) — slots can only be found from today onward`,
        };
      }
      // The subject-defaulted clamp is GONE with the stored window (rung 9a).
      // It existed because an unplaced subject defaulted the search bounds from
      // its OWN date range, which could be wider than the 14-day cap or start
      // in the past — and erroring on values the caller never passed was a dead
      // end. Every subject now defaults to today..today+13, which already
      // satisfies both rules, so there is nothing left to clamp. Explicit args
      // keep the hard errors above.
      const spanDays =
        (Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${earliest}T00:00:00Z`)) / 86_400_000 + 1;
      if (spanDays > 14) {
        return { status: 'invalid_range', note: 'range is capped at 14 days' };
      }
      // Unknown/deactivated pin → a clear error, not an empty search.
      if (pinnedRef) await resolveScheduleInputTarget(tenantId, pinnedRef);

      // ------- snapshot: version FIRST, then the schedule state it describes
      const scheduleVersion = await latestScheduleVersion(tenantId);
      const ctx = await assembleFitContext({
        tenantId,
        earliest,
        latest,
        ...(pinnedRef ? { technicianRef: pinnedRef } : {}),
        ...(requiredSkills ? { requiredSkills } : {}),
        ...(subjectRow ? { excludeVisitId: subjectRow.id } : {}),
      });
      const customerCity = customer.city?.trim().toLowerCase() || null;
      const generated = generateCandidates({
        todayISO,
        nowHHMM: localTimeHHMM(nowISO, tz),
        earliest,
        latest,
        durationMin,
        durationLabel,
        customerCity,
        priority: job?.priority ?? 'routine',
        technicians: ctx.technicians,
      });
      // Unknown-skills techs are candidates WITH a confirm-first flag (unknown
      // ≠ unqualified) — stamp the warning on their candidates, not just the
      // top-level list, so it survives into whatever the agent relays.
      if (requiredSkills && requiredSkills.length > 0 && ctx.unknownSkills.length > 0) {
        const unknown = new Set(ctx.unknownSkills);
        for (const c of generated) {
          if (unknown.has(c.technicianRef)) {
            c.warnings.push(
              `${c.technicianName}'s skills are not configured — confirm they can do ` +
                `${requiredSkills.join(', ')} before booking`,
            );
          }
        }
      }

      // ------- drive deltas: bounded, cached, degrade-only (no key = skip)
      const canMeasure = Boolean(deps.computeRoutes) || Boolean(process.env.GOOGLE_MAPS_API_KEY?.trim());
      let ranked: SlotCandidate[] = generated;
      if (generated.length > 0 && canMeasure) {
        const newStop: RouteStop = { label: customer.name, address: formatAddress(customer) };
        // The subject's CURRENT technician (assignment asks only): only THEIR
        // day may contain the subject's own stop — filtering other techs' days
        // by timestamp would silently drop a different person's same-instant
        // visit (review finding #1).
        // EVERY person on the subject trip. Their days all contain it (the
        // per-technician read is participant-rooted since rung 9c), so filtering
        // only the first one's day would score a crew-mate's candidates against
        // a route that still includes the stop being moved away. The original
        // safety argument — never drop a DIFFERENT person's same-instant visit
        // (review finding #1) — holds for a set exactly as it did for one ref.
        const subjectTechRefs = new Set<string>();
        for (const id of subjectCrewIds) {
          const ref = (await getTechnicianById(id, tenantId))?.ref;
          if (ref) subjectTechRefs.add(ref);
        }
        const pairs = [
          ...new Map(
            generated
              .slice(0, DRIVE_MEASURE_TOP)
              .map((c) => [techDateKey(c.technicianRef, c.date), c] as const),
          ).values(),
        ];
        const stopsByTechDate = new Map<string, RouteStop[]>();
        await Promise.all(
          pairs.map(async (c) => {
            const days = await listDayStops(tenantId, c.technicianRef, c.date, c.date);
            let stops = days[0]?.stops ?? [];
            // The assignment subject's own row must not count in its day's
            // route — it is exactly the stop being re-placed. A CREW trip sits
            // on every member's day (rung 9c), so the test is membership of the
            // subject's crew. Same person + identical start identifies it ONLY
            // for a confirmed subject
            // (confirmed rows cannot overlap); a PROPOSED subject is not in
            // listDayStops at all, and the DB legally allows a different
            // confirmed visit at the same instant — filtering would silently
            // drop that real stop (review round-2 residual).
            if (subjectRow?.status === 'confirmed' && subjectTechRefs.has(c.technicianRef)) {
              stops = stops.filter((s) => s.scheduledStart !== subjectRow.starts_at);
            }
            stopsByTechDate.set(techDateKey(c.technicianRef, c.date), stops);
          }),
        );
        ranked = await measureDriveDeltas(
          { candidates: generated, stopsByTechDate, newStop },
          deps.computeRoutes ? { computeRoutes: deps.computeRoutes } : {},
        );
      }
      const candidates = ranked.slice(0, 5);

      // ------- customer facts: unwrapped, retraction-filtered (context rules)
      const factIds = factSourceIds(customer.attributes);
      let foldedAttributes = customer.attributes;
      if (factIds.length > 0) {
        const retracted = new Set(
          (await findRetractionsFor(factIds))
            .map((r) => r.retracts_capture_id)
            .filter((id): id is string => !!id),
        );
        if (retracted.size > 0) foldedAttributes = foldRetractedFacts(customer.attributes, retracted);
      }
      const shared = {
        searched: { technicians: ctx.technicians.length, days: spanDays },
        skippedNoPattern: ctx.skippedNoPattern,
        skippedSkills: ctx.skippedSkills,
        unknownSkills: ctx.unknownSkills,
        ...(durationAssumption ? { durationAssumption } : {}),
        ...(assumedTypeNote ? { assumedType, assumedTypeNote } : {}),
        customerFacts: unwrapAttributes(foldedAttributes),
        scheduleVersion,
      };

      if (candidates.length === 0) {
        // NO DEAD ENDS: name the binding constraint and what could move.
        const constraints: string[] = [];
        if (ctx.technicians.length === 0) {
          if (ctx.skippedNoPattern.length > 0) {
            constraints.push(
              `no working pattern set for: ${ctx.skippedNoPattern.join(', ')} ` +
                '(set_availability makes them schedulable)',
            );
          }
          if (ctx.skippedSkills.length > 0) {
            constraints.push(
              `configured skills lack ${(requiredSkills ?? []).join(', ')}: ${ctx.skippedSkills.join(', ')}`,
            );
          }
          if (constraints.length === 0) {
            constraints.push(
              pinnedRef
                ? `technician '${pinnedRef}' is not schedulable in this range`
                : 'no active technicians are schedulable',
            );
          }
        } else {
          constraints.push(
            `no free ${durationLabel} gap between ${earliest} and ${latest} across ` +
              `${ctx.technicians.length} schedulable technician(s) — working windows, time ` +
              'off, and existing visits leave no room',
          );
        }
        // Nearest alternative beyond the range — with its OWN visit context
        // (reusing this range's context would score unseen days as empty).
        let nearestAlternative: Record<string, unknown> | undefined;
        if (ctx.technicians.length > 0) {
          const extCtx = await assembleFitContext({
            tenantId,
            earliest: addDaysISO(latest, 1),
            latest: addDaysISO(latest, 14),
            ...(pinnedRef ? { technicianRef: pinnedRef } : {}),
            ...(requiredSkills ? { requiredSkills } : {}),
            ...(subjectRow ? { excludeVisitId: subjectRow.id } : {}),
          });
          const beyond = generateCandidates({
            todayISO,
            nowHHMM: localTimeHHMM(nowISO, tz),
            earliest: addDaysISO(latest, 1),
            latest: addDaysISO(latest, 14),
            durationMin,
            durationLabel,
            customerCity,
            priority: job?.priority ?? 'routine',
            technicians: extCtx.technicians,
          });
          if (beyond.length > 0) {
            const b = beyond[0];
            nearestAlternative = {
              technicianRef: b.technicianRef,
              technicianName: b.technicianName,
              date: b.date,
              weekday: b.weekday,
              startTime: b.startTime,
              endTime: b.endTime,
              dayLevel: b.dayLevel,
              note: 'first fit BEYOND the requested range',
            };
          }
        }
        return {
          status: 'no_fit',
          ...shared,
          noFit: {
            bindingConstraint: constraints.join('; '),
            // The beyond-range hint is only honest when a beyond-range search
            // actually ran (a structural constraint — nobody schedulable —
            // was not searched further; fixing the named input comes first).
            ...(ctx.technicians.length > 0
              ? nearestAlternative
                ? { nearestAlternative }
                : {
                    hint:
                      'nothing fits even two weeks past the range — a shorter visit may ' +
                      'fit, or one of the displacement candidates below could move ' +
                      '(move_visit).',
                  }
              : {}),
            displacementCandidates: await findDisplacementCandidates(
              tenantId,
              earliest,
              latest,
              5,
              subjectRow?.id,
            ),
          },
          note:
            'Nothing fits as asked — do NOT stop at "impossible": present the binding ' +
            'constraint and the concrete options (nearest alternative / what could move) ' +
            'so the manager can decide.',
        };
      }
      return {
        status: 'ok',
        candidates,
        ...shared,
        note:
          'Read-only — nothing was booked. Present the options with their reasons (relay, ' +
          'do not re-derive); dayLevel:true means quote the DAY, not a time. Book the ' +
          "manager's choice with book_visit using the candidate's exact values.",
      };
}

export const scheduleTools = {
  domain: 'schedule',
  base: BASE_TOOLS,
  admin: ADMIN_TOOLS,
  handlers: {
    resolve_date: handleResolveDate,
    get_schedule: handleGetSchedule,
    get_team_schedule: handleGetTeamSchedule,
    book_visit: handleBookVisit,
    move_visit: handleMoveVisit,
    unschedule_visit: handleUnscheduleVisit,
    set_availability: handleSetAvailability,
    get_availability: handleGetAvailability,
    add_time_off: handleAddTimeOff,
    remove_time_off: handleRemoveTimeOff,
    set_job_duration: handleSetJobDuration,
    set_technician_horizon: handleSetTechnicianHorizon,
    set_timezone: handleSetTimezone,
    find_slots: handleFindSlots,
  },
} satisfies DomainTools;
