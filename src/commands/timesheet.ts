import type { Command } from "commander";
import { createCompanyResource } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import type { BlockedOn } from "../lib/output.ts";
import { isValidIso8601, isValidIsoDate, parsePositiveNumber } from "../lib/parse.ts";
import { type CommandHandler, type ValidationResult, runCommand, validationFailure } from "../lib/runner.ts";

type PayClassification = "Regular" | "Overtime" | "Double overtime";

// Maps each granular hour flag to the exact pay_classification enum string the
// Time Tracking API expects (see TimeTracking::TimeEntry#pay_classification).
const HOUR_FLAGS: {
  opt: "regular" | "overtime" | "doubleOvertime";
  field: string;
  classification: PayClassification;
}[] = [
  { opt: "regular", field: "regular", classification: "Regular" },
  { opt: "overtime", field: "overtime", classification: "Overtime" },
  { opt: "doubleOvertime", field: "double-overtime", classification: "Double overtime" },
];

interface TimeEntry {
  hours_worked: number;
  pay_classification: PayClassification;
}

/** Employee time sheets must carry a job; contractor time sheets must not. Modeled as a
 * discriminated union so invalid combinations (Contractor + job_uuid, Employee without one)
 * don't typecheck — mirrors the discriminated unions in contractor.ts. */
type TimesheetEntity = { entity_type: "Employee"; job_uuid: string } | { entity_type: "Contractor" };

export type TimesheetCreateBody = {
  entity_uuid: string;
  time_zone: string;
  shift_started_at: string;
  shift_ended_at?: string;
  entries: TimeEntry[];
} & TimesheetEntity;

export type TimesheetCreateValidation = ValidationResult<TimesheetCreateBody>;

interface TimesheetCreateInput {
  employeeUuid?: string;
  contractorUuid?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  jobUuid?: string;
  regular?: string;
  overtime?: string;
  doubleOvertime?: string;
}

/** Validate timesheet-create args and, on success, return the fully-populated request body.
 * Exactly one of --employee-uuid / --contractor-uuid sets the entity; at least one of the
 * granular hour flags is required and each becomes one `entries` row with its pay_classification. */
export function validateTimesheetCreate(opts: TimesheetCreateInput): TimesheetCreateValidation {
  const blocked: BlockedOn[] = [];

  const { start, timeZone } = opts;
  const ambiguousEntity = Boolean(opts.employeeUuid && opts.contractorUuid);
  const isEmployee = Boolean(opts.employeeUuid) && !opts.contractorUuid;
  const entityUuid = opts.employeeUuid ?? opts.contractorUuid;
  if (ambiguousEntity) {
    blocked.push({ field: "employee-uuid", reason: "pass only one of --employee-uuid or --contractor-uuid" });
  } else if (!entityUuid) {
    blocked.push({ field: "employee-uuid", reason: "required (or pass --contractor-uuid)" });
  }

  // The API requires a job for employee time sheets (TimeTracking::TimeSheet validates
  // employee_job_uuid presence if member_employee?); contractor time sheets don't take one.
  let entity: TimesheetEntity | undefined;
  if (isEmployee) {
    if (opts.jobUuid) {
      entity = { entity_type: "Employee", job_uuid: opts.jobUuid };
    } else {
      blocked.push({ field: "job-uuid", reason: "required for employee time sheets" });
    }
  } else if (entityUuid && !ambiguousEntity) {
    if (opts.jobUuid) {
      blocked.push({ field: "job-uuid", reason: "not supported for contractor time sheets" });
    } else {
      entity = { entity_type: "Contractor" };
    }
  }

  if (!start) {
    blocked.push({ field: "start", reason: "required (shift start, ISO 8601)" });
  } else if (!isValidIso8601(start)) {
    blocked.push({ field: "start", reason: "must be a valid ISO 8601 timestamp (e.g. 2026-06-01T09:00:00Z)" });
  }
  if (opts.end !== undefined && !isValidIso8601(opts.end)) {
    blocked.push({ field: "end", reason: "must be a valid ISO 8601 timestamp (e.g. 2026-06-01T17:30:00Z)" });
  }
  if (!timeZone) blocked.push({ field: "time-zone", reason: "required (e.g. America/New_York)" });

  const entries: TimeEntry[] = [];
  for (const { opt, field, classification } of HOUR_FLAGS) {
    const raw = opts[opt];
    if (raw === undefined) continue;
    const parsed = parsePositiveNumber(raw);
    if (!parsed.ok) {
      blocked.push({ field, reason: parsed.reason });
      continue;
    }
    entries.push({ hours_worked: parsed.value, pay_classification: classification });
  }
  if (entries.length === 0 && !hasAnyHourFlag(opts)) {
    blocked.push({ field: "hours", reason: "provide at least one of --regular, --overtime, --double-overtime" });
  }

  // Re-check the required locals in the guard so the compiler narrows them (entityUuid/start/
  // timeZone to `string`, entity to a concrete variant) for the body below.
  if (ambiguousEntity || !entityUuid || !entity || !start || !timeZone || blocked.length > 0) {
    return { ok: false, message: "missing or invalid arguments", blocked };
  }

  const body: TimesheetCreateBody = {
    entity_uuid: entityUuid,
    ...entity,
    time_zone: timeZone,
    shift_started_at: start,
    ...(opts.end ? { shift_ended_at: opts.end } : {}),
    entries,
  };
  return { ok: true, body };
}

/** True when any hour flag was supplied (defined), regardless of whether it parsed —
 * lets the caller skip the generic "provide at least one" block when a specific
 * bad-value block has already been pushed for that flag. */
function hasAnyHourFlag(opts: TimesheetCreateInput): boolean {
  return HOUR_FLAGS.some(({ opt }) => opts[opt] !== undefined);
}

export interface TimesheetSyncBody {
  // Only regular payroll exports are supported today (TimeTracking::ValueObjects::PayrollExport::Kind),
  // so this is a constant rather than `string`.
  kind: "regular";
  pay_schedule_uuid: string;
  pay_period_start_date: string;
  pay_period_end_date: string;
}

export type TimesheetSyncValidation = ValidationResult<TimesheetSyncBody>;

interface TimesheetSyncInput {
  payScheduleUuid?: string;
  payPeriodStart?: string;
  payPeriodEnd?: string;
}

/** Validate timesheet-sync args and, on success, return the payroll-sync request body.
 * `kind` is always "regular" — the API only supports regular payroll exports today. */
export function validateTimesheetSync(opts: TimesheetSyncInput): TimesheetSyncValidation {
  const blocked: BlockedOn[] = [];
  const { payScheduleUuid, payPeriodStart, payPeriodEnd } = opts;
  if (!payScheduleUuid) blocked.push({ field: "pay-schedule-uuid", reason: "required" });
  if (!payPeriodStart) {
    blocked.push({ field: "pay-period-start", reason: "required (YYYY-MM-DD)" });
  } else if (!isValidIsoDate(payPeriodStart)) {
    blocked.push({ field: "pay-period-start", reason: "must be a valid date in YYYY-MM-DD format" });
  }
  if (!payPeriodEnd) {
    blocked.push({ field: "pay-period-end", reason: "required (YYYY-MM-DD)" });
  } else if (!isValidIsoDate(payPeriodEnd)) {
    blocked.push({ field: "pay-period-end", reason: "must be a valid date in YYYY-MM-DD format" });
  }

  // Re-check the locals (narrows them to `string`) and catch any format errors above.
  if (!payScheduleUuid || !payPeriodStart || !payPeriodEnd || blocked.length > 0) {
    return { ok: false, message: "missing or invalid arguments", blocked };
  }

  return {
    ok: true,
    body: {
      kind: "regular",
      pay_schedule_uuid: payScheduleUuid,
      pay_period_start_date: payPeriodStart,
      pay_period_end_date: payPeriodEnd,
    },
  };
}

interface TimesheetCreateOpts extends TimesheetCreateInput {
  companyUuid?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

interface TimesheetSyncOpts extends TimesheetSyncInput {
  companyUuid?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

// Note: `kind` is intentionally not a flag — only regular payroll exports are supported today.

export function registerTimesheetCommand(parent: Command): void {
  const cmd = parent.command("timesheet").description("Sync hours to timesheets and sync them to payroll");

  cmd
    .command("create")
    .description("Create a time sheet (classified hours for an employee or contractor)")
    .option("--employee-uuid <uuid>", "Employee UUID (sets entity_type Employee)")
    .option("--contractor-uuid <uuid>", "Contractor UUID (sets entity_type Contractor)")
    .option("--start <timestamp>", "Shift start (ISO 8601); the API names this `shift_started_at`")
    .option("--end <timestamp>", "Shift end (ISO 8601); omit for an ongoing shift")
    .option("--time-zone <tz>", "Time zone where the hours were tracked (e.g. America/New_York)")
    .option("--job-uuid <uuid>", "Job UUID the hours are tracked against (required for employees)")
    .option("--regular <hours>", "Regular hours worked")
    .option("--overtime <hours>", "Overtime hours worked")
    .option("--double-overtime <hours>", "Double-overtime hours worked")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option("--dry-run", "Build the request without sending")
    .option("--example", "Print a canned sample payload without calling the API")
    .action((opts: TimesheetCreateOpts) =>
      runCommand("gusto timesheet create", readGlobalFlags(parent.opts()), timesheetCreateHandler(opts)),
    );

  cmd
    .command("sync")
    .description("Sync a pay period's time sheets into a draft payroll (async)")
    .option("--pay-schedule-uuid <uuid>", "Pay schedule UUID for the pay period")
    .option("--pay-period-start <date>", "Pay period start (YYYY-MM-DD)")
    .option("--pay-period-end <date>", "Pay period end (YYYY-MM-DD)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option("--dry-run", "Build the request without sending")
    .option("--example", "Print a canned sample payload without calling the API")
    .action((opts: TimesheetSyncOpts) =>
      runCommand("gusto timesheet sync", readGlobalFlags(parent.opts()), timesheetSyncHandler(opts)),
    );
}

export function timesheetCreateHandler(opts: TimesheetCreateOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/time_tracking/time_sheets",
          body: {
            entity_uuid: "9b8c7d6e-0000-1111-2222-333344445555",
            entity_type: "Employee",
            job_uuid: "1f2e3d4c-0000-1111-2222-333344445555",
            time_zone: "America/New_York",
            shift_started_at: "2026-06-01T09:00:00Z",
            shift_ended_at: "2026-06-01T17:30:00Z",
            entries: [
              { hours_worked: 8, pay_classification: "Regular" },
              { hours_worked: 0.5, pay_classification: "Overtime" },
            ],
          },
          note: "example: canonical request shape; time sheets are created approved",
        },
      };
    }

    const validation = validateTimesheetCreate(opts);
    if (!validation.ok) return validationFailure(validation.message, validation.blocked);

    return createCompanyResource(globals, "time_tracking/time_sheets", validation.body, {
      tokenStdin: opts.tokenStdin,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
}

export function timesheetSyncHandler(opts: TimesheetSyncOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/time_tracking/payroll_syncs",
          body: {
            kind: "regular",
            pay_schedule_uuid: "1a2b3c4d-0000-1111-2222-333344445555",
            pay_period_start_date: "2026-06-01",
            pay_period_end_date: "2026-06-15",
          },
          note: "example: async sync; response returns a PayrollSync with status pending",
        },
      };
    }

    const validation = validateTimesheetSync(opts);
    if (!validation.ok) return validationFailure(validation.message, validation.blocked);

    return createCompanyResource(globals, "time_tracking/payroll_syncs", validation.body, {
      tokenStdin: opts.tokenStdin,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
}
