import type { Command } from "commander";
import type { ApiResponse } from "../lib/api-client.ts";
import {
  fetchAtPath,
  fetchResource,
  putResourceWithVersion,
  resolveApiContext,
  withCompanyContext,
  writeResource,
} from "../lib/api-context.ts";
import {
  ALL_OPT,
  CONFIRM_OPT,
  CURSOR_OPT,
  DRY_RUN_OPT,
  EXAMPLE_OPT,
  TOKEN_STDIN_OPT,
  withContextOptions,
} from "../lib/cli-options.ts";
import { confirmationGate } from "../lib/confirm.ts";
import {
  buildHomeAddressUpdate,
  buildWorkAddressUpdate,
  type HomeAddressBody,
  type HomeAddressUpdateOpts,
  type WorkAddressBody,
  type WorkAddressUpdateOpts,
} from "../lib/employee-address.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { partialFailure } from "../lib/handle-api-error.ts";
import { fetchCompanyLocations, findLocationForState } from "../lib/locations.ts";
import { parsePaginationFlags } from "../lib/pagination.ts";
import { malformedResponse } from "../lib/errors.ts";
import { isValidIsoDate, isValidStateCode, isValidUuid } from "../lib/parse.ts";
import { isObject } from "../lib/predicates.ts";
import {
  type CommandHandler,
  type CommandResult,
  invalidUuid,
  missingArgs,
  runCommand,
  runReadCommand,
  validationFailure,
} from "../lib/runner.ts";

/** Where a caller goes to get a real identifier when the one they passed can't name a record. Named
 * here rather than inline so every handler taking the same identifier quotes the same command - an
 * agent following the hint should land in the same place each time. */
const EMPLOYEE_LOOKUP = "gusto employee list";
const ADDRESS_LOOKUP = "gusto employee addresses <employee_uuid>";

interface EmployeeListOpts {
  status?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
  cursor?: string;
  limit?: string;
  all?: boolean;
}

interface EmployeeShowOpts {
  tokenStdin?: boolean;
}

/** Auth + write-gate flags every address update command shares. */
interface AddressWriteOpts {
  tokenStdin?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
  example?: boolean;
}

type HomeAddressUpdateCmdOpts = HomeAddressUpdateOpts & AddressWriteOpts;
type WorkAddressUpdateCmdOpts = WorkAddressUpdateOpts & AddressWriteOpts;

export function registerEmployeeCommand(parent: Command): void {
  const cmd = parent.command("employee").description("List and inspect W-2 employees");

  cmd
    .command("show <employee_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read employee record")
    .option(...TOKEN_STDIN_OPT)
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand("gusto employee show", readGlobalFlags(parent.opts()), employeeShowHandler(employeeUuid, opts)),
    );

  cmd
    .command("status <employee_uuid>")
    .description("Show onboarding status + the completed/required steps and any blockers")
    .option(...TOKEN_STDIN_OPT)
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee status",
        readGlobalFlags(parent.opts()),
        employeeStatusHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("history <employee_uuid>")
    .description("Read an employee's employment history (termination + rehire dates)")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee history <employee_uuid>   # full employment history, incl. termination + rehire dates

One record spanning the employee's tenure. For the standalone termination or rehire
records, use \`employee terminations\`/\`employee rehire\`.
`,
    )
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee history",
        readGlobalFlags(parent.opts()),
        employeeHistoryHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("terminations <employee_uuid>")
    .description("List an employee's terminations")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee terminations <employee_uuid>   # every termination on record for the employee

Returns a list, but an employee has at most one termination, so it holds zero or
one record (empty until the employee is terminated).
`,
    )
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee terminations",
        readGlobalFlags(parent.opts()),
        employeeTerminationsHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("rehire <employee_uuid>")
    .description("Read an employee's rehire record")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee rehire <employee_uuid>   # when the employee is scheduled to return to work
`,
    )
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee rehire",
        readGlobalFlags(parent.opts()),
        employeeRehireHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("addresses <employee_uuid>")
    .description("Read an employee's work and home addresses")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee addresses <employee_uuid>                      # work + home addresses
  $ gusto employee addresses <employee_uuid> --fields work_addresses   # just the work list

Returns both address lists under \`work_addresses\` and \`home_addresses\`. Each entry
carries its own UUID; pass it to \`employee work-address\`/\`home-address\` for a single record.
`,
    )
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee addresses",
        readGlobalFlags(parent.opts()),
        employeeAddressesHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("work-address <address_uuid>")
    .description("Read a single work address by UUID")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee work-address <address_uuid>   # one work address; UUIDs come from \`employee addresses\`
`,
    )
    .action((addressUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee work-address",
        readGlobalFlags(parent.opts()),
        workAddressHandler(addressUuid, opts),
      ),
    );

  cmd
    .command("home-address <address_uuid>")
    .description("Read a single home address by UUID")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee home-address <address_uuid>   # one home address; UUIDs come from \`employee addresses\`
`,
    )
    .action((addressUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee home-address",
        readGlobalFlags(parent.opts()),
        homeAddressHandler(addressUuid, opts),
      ),
    );

  cmd
    .command("update-home-address <address_uuid>")
    .description("Update an employee's home address (partial; only the flags you pass change)")
    .option("--street-1 <street>", "Street line 1")
    .option("--street-2 <street>", "Street line 2")
    .option("--city <city>", "City")
    .option("--state <state>", "Two-letter state code (e.g. CO)")
    .option("--zip <zip>", "ZIP code")
    .option("--effective-date <date>", "Date the address takes effect (YYYY-MM-DD)")
    .option("--courtesy-withholding <bool>", "Courtesy withholding: true or false")
    .option("--record-version <token>", "Resource version; skips the auto-fetch (a value you pass always wins)")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...CONFIRM_OPT)
    .option(...EXAMPLE_OPT)
    .addHelpText(
      "after",
      `
Address UUIDs come from \`gusto employee addresses <employee_uuid>\`. This is a partial update:
only the fields you pass are changed. The optimistic-concurrency \`version\` is read from the
current record automatically; pass --record-version to supply it yourself and skip that read.
If the record changes before the write, nothing is saved and you get a \`version_conflict\`
(exit 8). On the automatic read, re-running picks up the current version. If you passed
--record-version, re-running re-sends the same stale token: read the record again with
\`gusto employee home-address <address_uuid>\` and pass its new \`version\`.

Empty flag values are rejected, so \`--street-2 ""\` won't clear an existing line 2: it returns
\`blocked_on\` (exit 7). There is no clear flag yet; \`gusto api request PUT\` can do it, without
the automatic version read.

Examples:
  $ gusto employee update-home-address <address_uuid> --street-1 "123 Main St" --city Denver --state CO --zip 80202
  $ gusto employee update-home-address <address_uuid> --zip 80203 --dry-run
`,
    )
    .action((addressUuid: string, opts: HomeAddressUpdateCmdOpts) =>
      runCommand(
        "gusto employee update-home-address",
        readGlobalFlags(parent.opts()),
        updateHomeAddressHandler(addressUuid, opts),
      ),
    );

  cmd
    .command("update-work-address <address_uuid>")
    .description("Update an employee's work address (partial; only the flags you pass change)")
    .option("--location-uuid <uuid>", "Company location the work address points at")
    .option("--effective-date <date>", "Date the address takes effect (YYYY-MM-DD)")
    .option("--record-version <token>", "Resource version; skips the auto-fetch (a value you pass always wins)")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...CONFIRM_OPT)
    .option(...EXAMPLE_OPT)
    .addHelpText(
      "after",
      `
A work address points at one of the company's locations; set it via --location-uuid (list them
with \`gusto company locations\`). Address UUIDs come from \`gusto employee addresses <employee_uuid>\`.
The \`version\` is read from the current record automatically; pass --record-version to skip that read.
If the record changes before the write, nothing is saved and you get a \`version_conflict\`
(exit 8). On the automatic read, re-running picks up the current version. If you passed
--record-version, re-running re-sends the same stale token: read the record again with
\`gusto employee work-address <address_uuid>\` and pass its new \`version\`.

Examples:
  $ gusto employee update-work-address <address_uuid> --location-uuid <company_location_uuid>
  $ gusto employee update-work-address <address_uuid> --effective-date 2026-08-01 --dry-run
`,
    )
    .action((addressUuid: string, opts: WorkAddressUpdateCmdOpts) =>
      runCommand(
        "gusto employee update-work-address",
        readGlobalFlags(parent.opts()),
        updateWorkAddressHandler(addressUuid, opts),
      ),
    );

  cmd
    .command("jobs <employee_uuid>")
    .description("Read an employee's jobs")
    .option(...TOKEN_STDIN_OPT)
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand("gusto employee jobs", readGlobalFlags(parent.opts()), employeeJobsHandler(employeeUuid, opts)),
    );

  withContextOptions(
    cmd
      .command("update <employee_uuid>")
      .description("Update an employee's work state (write path); flags the new state's tax requirements"),
  )
    .option("--work-state <state>", "New work-state 2-letter code (e.g. MD)")
    .option("--effective-date <date>", "The date the work-state change takes effect (YYYY-MM-DD)")
    .option(...DRY_RUN_OPT)
    .option(...CONFIRM_OPT)
    .option(...EXAMPLE_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee update <uuid> --work-state MD
  $ gusto employee update <uuid> --work-state MD --effective-date 2026-08-01

Resolves --work-state to one of the company's existing locations in that state (see
\`gusto company locations\`) and points the employee's active work address at it - create
the location first if none exists yet. On success the response includes a \`compliance\`
block naming that state's outstanding tax requirements, so a silent PA-to-MD move doesn't
turn into months of missed filings. Already working from --work-state is a no-op
(\`changed: false\`); no location lookup or write is attempted.

Mirrors PUT /v1/work_addresses/{work_address_uuid}. In agent mode this write is gated:
preview it with --dry-run, then re-run with --confirm once the operator approves.
`,
    )
    .action((employeeUuid: string, opts: EmployeeUpdateOpts) =>
      runCommand("gusto employee update", readGlobalFlags(parent.opts()), employeeUpdateHandler(employeeUuid, opts)),
    );

  cmd
    .command("custom-fields <employee_uuid>")
    .description("Read an employee's custom field values")
    .option(...TOKEN_STDIN_OPT)
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee custom-fields",
        readGlobalFlags(parent.opts()),
        employeeCustomFieldsHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("list")
    .description("List company employees (active by default)")
    .option("--status <status>", "Which employees to list: active, onboarding, terminated, or all", "active")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...CURSOR_OPT)
    .option("--limit <n>", "Maximum employees to return across pages")
    .option(...ALL_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee list                      # active employees, first page (100)
  $ gusto employee list --all                # every active employee, all pages
  $ gusto employee list --status all         # every record, first page
  $ gusto employee list --cursor <next>      # the next page, using a prior response's next

When more pages exist the response carries an opaque \`next\`; pass it back via --cursor,
or use --all to fetch everything. \`summary\` (the full active/onboarding/terminated
breakdown) is included only when the result is complete, so a partial page's counts are
never read as company totals.
`,
    )
    .action((opts: EmployeeListOpts) =>
      runReadCommand("gusto employee list", readGlobalFlags(parent.opts()), employeeListHandler(opts)),
    );

  // `terminate` (schedule) and `cancel-termination` (undo) are flat sibling actions, mirroring the
  // existing `show`/`status`/`list` structure. They deliberately aren't a `terminate`
  // command-plus-`cancel`-subcommand: a command that has its own action + positional AND a
  // subcommand forces commander into positional-option mode, which drops trailing global flags
  // (`--json`/`--agent`) - the CLI's core agent surface.
  cmd
    .command("terminate <employee_uuid>")
    .description("Schedule an employee termination (the offboarding write path)")
    .option("--effective-date <date>", "The employee's last day of work (YYYY-MM-DD)")
    .option(
      "--run-termination-payroll",
      "Pay final wages via a one-off off-cycle payroll instead of the regular pay schedule",
    )
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...CONFIRM_OPT)
    .option(...EXAMPLE_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee terminate <uuid> --effective-date 2026-08-01
  $ gusto employee terminate <uuid> --effective-date 2026-08-01 --run-termination-payroll
  $ gusto employee cancel-termination <uuid>   # undo a pending termination

Mirrors POST /v1/employees/{id}/terminations. In agent mode this write is gated:
preview it with --dry-run, then re-run with --confirm once the operator approves.
Some states require final wages within 24 hours, where --run-termination-payroll
may be the only compliant option.
`,
    )
    .action((employeeUuid: string, opts: EmployeeTerminateOpts) =>
      runCommand(
        "gusto employee terminate",
        readGlobalFlags(parent.opts()),
        employeeTerminateHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("cancel-termination <employee_uuid>")
    .description("Cancel a pending (scheduled) employee termination")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...CONFIRM_OPT)
    .addHelpText(
      "after",
      `
Example:
  $ gusto employee cancel-termination <uuid>

Mirrors DELETE /v1/employees/{id}/terminations. Gated in agent mode like any write:
preview with --dry-run, then re-run with --confirm once the operator approves.
`,
    )
    .action((employeeUuid: string, opts: EmployeeTerminateCancelOpts) =>
      runCommand(
        "gusto employee cancel-termination",
        readGlobalFlags(parent.opts()),
        employeeTerminateCancelHandler(employeeUuid, opts),
      ),
    );
}

function employeeShowHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/employees/${encodeURIComponent(employeeUuid)}`,
    );
  };
}

export function employeeCustomFieldsHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/employees/${encodeURIComponent(employeeUuid)}/custom_fields`,
    );
  };
}

function employeeStatusHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/employees/${encodeURIComponent(employeeUuid)}/onboarding_status`,
    );
  };
}

export function workAddressHandler(addressUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(addressUuid)) return invalidUuid("address_uuid", addressUuid, ADDRESS_LOOKUP);
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/work_addresses/${encodeURIComponent(addressUuid)}`,
    );
  };
}

export function homeAddressHandler(addressUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(addressUuid)) return invalidUuid("address_uuid", addressUuid, ADDRESS_LOOKUP);
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/home_addresses/${encodeURIComponent(addressUuid)}`,
    );
  };
}

// Two independent GETs on the employee-scoped (no company) path, run in parallel
// and combined under stable keys. Either failing fails the whole command (work's
// error wins if both fail); each error names its side + employee. The single-address
// gets exist for granular access when one side errors. A 2xx that isn't a JSON array
// is rejected as malformed rather than passed through, so the address list contract
// (and --fields discovery over it) stays honest.
export function employeeAddressesHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    const resolved = await resolveApiContext(globals, { tokenStdin: opts.tokenStdin, requireCompany: false });
    if (!resolved.ok) return resolved.result;

    const [work, home] = await Promise.all([
      fetchAtPath(resolved.ctx.client, `/v1/employees/${encodeURIComponent(employeeUuid)}/work_addresses`),
      fetchAtPath(resolved.ctx.client, `/v1/employees/${encodeURIComponent(employeeUuid)}/home_addresses`),
    ]);
    if (!work.ok) {
      return {
        ok: false,
        exitCode: work.exitCode,
        error: {
          ...work.error,
          message: `looking up work addresses for employee ${employeeUuid}: ${work.error.message}`,
        },
      };
    }
    if (!home.ok) {
      return {
        ok: false,
        exitCode: home.exitCode,
        error: {
          ...home.error,
          message: `looking up home addresses for employee ${employeeUuid}: ${home.error.message}`,
        },
      };
    }
    if (!Array.isArray(work.data)) {
      return malformedResponse(`/v1/employees/${employeeUuid}/work_addresses returned a non-array body`);
    }
    if (!Array.isArray(home.data)) {
      return malformedResponse(`/v1/employees/${employeeUuid}/home_addresses returned a non-array body`);
    }

    return { ok: true, data: { work_addresses: work.data, home_addresses: home.data } };
  };
}

export function updateHomeAddressHandler(addressUuid: string, opts: HomeAddressUpdateCmdOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/home_addresses/{home_address_uuid}",
          body: {
            street_1: "123 Main St",
            street_2: "Apt 4",
            city: "Denver",
            state: "CO",
            zip: "80202",
          } satisfies HomeAddressBody,
          note: "example: a partial update - pass only the fields you change; version is read from the current record unless you pass --record-version",
        },
      };
    }
    if (!isValidUuid(addressUuid)) return invalidUuid("address_uuid", addressUuid, ADDRESS_LOOKUP);
    const validated = buildHomeAddressUpdate(opts);
    if (!validated.ok) return validationFailure(validated.message, validated.blocked);
    return putResourceWithVersion(globals, `/v1/home_addresses/${encodeURIComponent(addressUuid)}`, validated.body, {
      tokenStdin: opts.tokenStdin,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
    });
  };
}

export function updateWorkAddressHandler(addressUuid: string, opts: WorkAddressUpdateCmdOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/work_addresses/{work_address_uuid}",
          body: { location_uuid: "<company_location_uuid>", effective_date: "2026-08-01" } satisfies WorkAddressBody,
          note: "example: a work address points at a company location; version is read from the current record unless you pass --record-version",
        },
      };
    }
    if (!isValidUuid(addressUuid)) return invalidUuid("address_uuid", addressUuid, ADDRESS_LOOKUP);
    const validated = buildWorkAddressUpdate(opts);
    if (!validated.ok) return validationFailure(validated.message, validated.blocked);
    return putResourceWithVersion(globals, `/v1/work_addresses/${encodeURIComponent(addressUuid)}`, validated.body, {
      tokenStdin: opts.tokenStdin,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
    });
  };
}

export function employeeHistoryHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/employees/${encodeURIComponent(employeeUuid)}/employment_history`,
    );
  };
}

export function employeeTerminationsHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/employees/${encodeURIComponent(employeeUuid)}/terminations`,
    );
  };
}

export function employeeRehireHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/employees/${encodeURIComponent(employeeUuid)}/rehire`,
    );
  };
}

export function employeeJobsHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    const res = await fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/employees/${encodeURIComponent(employeeUuid)}/jobs`,
    );
    if (res.ok && !Array.isArray(res.data)) {
      return malformedResponse(`/v1/employees/${employeeUuid}/jobs returned a non-array body`);
    }
    return res;
  };
}

interface EmployeeUpdateOpts {
  workState?: string;
  effectiveDate?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
  example?: boolean;
}

interface WorkAddressRecord {
  uuid: string;
  version: string;
  active?: boolean;
  state?: string;
  location_uuid?: string;
  [key: string]: unknown;
}

/** The work-address PUT body. `location_uuid` always points at the resolved --work-state
 * company location; `effective_date` is only sent when the operator gave one, matching the
 * API's own optionality (see the terminate body's opposite convention, where every field
 * is always sent - here that would invent a date semantics the API doesn't document). */
interface WorkAddressUpdateBody {
  version: string;
  location_uuid: string;
  effective_date?: string;
}

const workAddressPath = (workAddressUuid: string): string =>
  `/v1/work_addresses/${encodeURIComponent(workAddressUuid)}`;

/** Update an employee's work state: resolve --work-state to one of the company's
 * locations, then PUT the employee's active work address to point at it - the write
 * `terminate`'s single-request helpers don't fit, since building the body needs two prior
 * reads (the active work address, the target location). Gated like any write: the
 * confirmation check runs before any network call, against the write's shape rather than
 * the specific work-address uuid (not known yet). On success, a best-effort GET of the new
 * state's tax_requirements is shaped into a `compliance` nudge (see buildComplianceNudge);
 * its failure doesn't undo or fail the already-successful write. Already being in
 * --work-state is a no-op - no location lookup, no write, no nudge. */
export function employeeUpdateHandler(employeeUuid: string, opts: EmployeeUpdateOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/work_addresses/{work_address_uuid}",
          body: {
            version: "<current version>",
            location_uuid: "<company location uuid in the target state>",
            effective_date: "2026-08-01",
          } satisfies WorkAddressUpdateBody,
          note:
            "example: --work-state resolves to an existing company location in that state (see `gusto company " +
            "locations`), then PUTs the employee's active work address to point at it. A `compliance` block " +
            "naming the new state's outstanding tax requirements is included on success.",
        },
      };
    }
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    if (!opts.workState) {
      return missingArgs([{ field: "work-state", reason: "required (2-letter US state code, e.g. MD)" }]);
    }
    if (!isValidStateCode(opts.workState)) {
      return validationFailure("invalid --work-state", [
        { field: "work-state", reason: "must be a 2-letter state code" },
      ]);
    }
    if (opts.effectiveDate !== undefined && !isValidIsoDate(opts.effectiveDate)) {
      return validationFailure("invalid --effective-date", [
        { field: "effective-date", reason: "must be a valid date in YYYY-MM-DD format" },
      ]);
    }
    const workState = opts.workState.toUpperCase();

    // Gate on the write's shape before any reads - the work-address uuid isn't known yet.
    const gate = confirmationGate(globals, "PUT", "/v1/work_addresses/{work_address_uuid}", {
      confirm: opts.confirm,
      dryRun: opts.dryRun,
    });
    if (gate) return gate;

    return withCompanyContext(
      globals,
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      async (companyCtx) => {
        const addressesPath = `/v1/employees/${encodeURIComponent(employeeUuid)}/work_addresses`;
        const addressesRes = await fetchAtPath<WorkAddressRecord[]>(companyCtx.client, addressesPath);
        if (!addressesRes.ok) return addressesRes;
        if (!Array.isArray(addressesRes.data)) {
          return malformedResponse(`${addressesPath} returned a non-array body`);
        }
        // Strict `=== true`, unlike findLocationForState's permissive `!== false` - picking
        // the wrong address to overwrite is worse than failing to find one.
        const active = addressesRes.data.find((a) => a.active === true);
        if (!active) {
          return {
            ok: false,
            exitCode: ExitCode.ApiClient,
            error: {
              code: "no_active_work_address",
              message: `employee ${employeeUuid} has no active work address to update`,
            },
          };
        }
        if (active.state?.toUpperCase() === workState) {
          return {
            ok: true,
            data: {
              changed: false,
              work_address: active,
              note: `already working from ${workState}; nothing to update`,
            },
          };
        }

        const locationsRes = await fetchCompanyLocations(companyCtx.client, companyCtx.companyUuid);
        if (!locationsRes.ok) return locationsRes;
        const location = findLocationForState(locationsRes.data, workState);
        if (!location) {
          return {
            ok: false,
            exitCode: ExitCode.ApiClient,
            error: {
              code: "no_company_location_for_state",
              message:
                `no active company location in ${workState} - create one first (see \`gusto company locations\`) ` +
                "before moving an employee's work state there",
            },
          };
        }

        const body: WorkAddressUpdateBody = { version: active.version, location_uuid: location.uuid };
        if (opts.effectiveDate !== undefined) body.effective_date = opts.effectiveDate;

        const path = workAddressPath(active.uuid);
        if (opts.dryRun) return { ok: true, data: { method: "PUT", path, body } };

        const response = await companyCtx.client.request<WorkAddressRecord>("PUT", path, body);

        let nudgeResponse: ApiResponse<TaxRequirementsStateResponse>;
        try {
          nudgeResponse = await companyCtx.client.get<TaxRequirementsStateResponse>(
            `/v1/companies/${companyCtx.companyUuid}/tax_requirements/${encodeURIComponent(workState)}`,
          );
        } catch (err) {
          // A failed nudge fetch after a successful write is exactly what partialFailure models -
          // ok: false (not a data-level flag `--fields` could drop) so the failure can't go unseen.
          return partialFailure({
            code: "compliance_nudge_fetch_failed",
            message: `wrote the work-state change to ${workState}, but couldn't fetch its tax requirements`,
            err,
            completed: { work_address: response.body },
            failedDomain: "tax_requirements",
          });
        }

        const compliance = buildComplianceNudge(workState, nudgeResponse.body);
        return { ok: true, data: { changed: true, work_address: response.body, compliance } };
      },
    );
  };
}

interface EmployeeTerminateOpts {
  effectiveDate?: string;
  runTerminationPayroll?: boolean;
  tokenStdin?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
  example?: boolean;
}

interface EmployeeTerminateCancelOpts {
  tokenStdin?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
}

/** The termination request body. `run_termination_payroll` is always sent (API default is false),
 * so the request is self-documenting and the dry-run preview matches what actually goes over the wire. */
interface TerminationBody {
  effective_date: string;
  run_termination_payroll: boolean;
}

// Encode the uuid as a single path segment: a raw `/`, `?`, or `#` in an agent-supplied
// uuid would otherwise retarget the write (the client resolves paths via `new URL`).
const terminationsPath = (employeeUuid: string): string =>
  `/v1/employees/${encodeURIComponent(employeeUuid)}/terminations`;

/** Schedule a termination: POST /v1/employees/{id}/terminations. `effective_date` is the only
 * required field; `run_termination_payroll` decides whether final wages go out off-cycle. Semantic
 * validation (a real date, not already terminated) is the API's job - this enforces presence and ISO format. */
export function employeeTerminateHandler(employeeUuid: string, opts: EmployeeTerminateOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/employees/{employee_id}/terminations",
          body: { effective_date: "2026-08-01", run_termination_payroll: false } satisfies TerminationBody,
          note: "example: --effective-date is the last day of work; add --run-termination-payroll to pay final wages off-cycle",
        },
      };
    }
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    if (!opts.effectiveDate) {
      return missingArgs([
        { field: "effective-date", reason: "required (YYYY-MM-DD, the employee's last day of work)" },
      ]);
    }
    if (!isValidIsoDate(opts.effectiveDate)) {
      return validationFailure("invalid --effective-date", [
        { field: "effective-date", reason: "must be a valid date in YYYY-MM-DD format" },
      ]);
    }
    const body: TerminationBody = {
      effective_date: opts.effectiveDate,
      run_termination_payroll: opts.runTerminationPayroll === true,
    };
    return writeResource(globals, "POST", terminationsPath(employeeUuid), body, {
      tokenStdin: opts.tokenStdin,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
    });
  };
}

/** True when a Gusto error body carries a `not_found` category entry. The API returns `not_found`
 * for BOTH a "nothing is scheduled to cancel" DELETE and a DELETE against an unknown employee uuid.
 * The API's own message (which now reaches human mode via writeHumanError's `reason:` line) tells
 * those apart; this predicate only decides whether to add the extra safety hint below. */
function isNotFoundError(details: unknown): boolean {
  return (
    isObject(details) &&
    Array.isArray(details.errors) &&
    details.errors.some((e) => isObject(e) && e.category === "not_found")
  );
}

/** Both cancel-termination 404s now surface their distinct API message via the `reason:` line, so the
 * hint no longer carries the message - it adds the safety note the raw message doesn't spell out: a
 * mistyped uuid also 404s, silently leaving a real termination scheduled. No-op unless not_found. */
function surfaceCancelNotFound(result: CommandResult): CommandResult {
  if (result.ok || !isNotFoundError(result.error.details)) return result;
  return {
    ...result,
    error: {
      ...result.error,
      hint: "a 404 here means either nothing was scheduled to cancel, or the employee uuid is unknown - re-verify the uuid, since a real termination may still be scheduled",
    },
  };
}

/** Cancel a pending termination: DELETE /v1/employees/{id}/terminations (no body, 204 on success). */
export function employeeTerminateCancelHandler(
  employeeUuid: string,
  opts: EmployeeTerminateCancelOpts,
): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(employeeUuid)) return invalidUuid("employee_uuid", employeeUuid, EMPLOYEE_LOOKUP);
    return surfaceCancelNotFound(
      await writeResource(globals, "DELETE", terminationsPath(employeeUuid), undefined, {
        tokenStdin: opts.tokenStdin,
        dryRun: opts.dryRun,
        confirm: opts.confirm,
      }),
    );
  };
}

interface TaxRequirement {
  key: string;
  label?: string;
  value?: unknown;
  editable?: boolean;
  payroll_blocking?: boolean;
}

interface TaxRequirementSet {
  key: string;
  requirements?: TaxRequirement[];
}

export interface TaxRequirementsStateResponse {
  state?: string;
  requirement_sets?: TaxRequirementSet[];
}

export interface ComplianceOutstandingItem {
  key: string;
  label?: string;
  payroll_blocking: boolean;
}

export interface ComplianceNudge {
  state: string;
  outstanding: ComplianceOutstandingItem[];
  payroll_blocking: boolean;
}

/** Shape a `tax_requirements/{state}` response into the "what still needs attention"
 * nudge shown after a work-state change: every editable requirement with no value yet
 * (`null`, `undefined`, or `""`), flagging whether any of them block payroll. */
export function buildComplianceNudge(state: string, response: TaxRequirementsStateResponse): ComplianceNudge {
  const outstanding = (response.requirement_sets ?? [])
    .flatMap((set) => set.requirements ?? [])
    .filter((r) => r.editable === true && (r.value === null || r.value === undefined || r.value === ""))
    .map((r) => ({ key: r.key, label: r.label, payroll_blocking: r.payroll_blocking === true }));
  return { state, outstanding, payroll_blocking: outstanding.some((r) => r.payroll_blocking) };
}

export function employeeListHandler(opts: EmployeeListOpts): CommandHandler {
  return async ({ globals }) => {
    const parsed = parseStatus(opts.status);
    if (!parsed.ok) {
      return validationFailure("invalid --status", [{ field: "status", reason: parsed.reason }]);
    }
    const pg = parsePaginationFlags(opts);
    if (!pg.ok) return validationFailure(pg.message, pg.blocked);

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const { items, next, complete } = await ctx.client.paginate<EmployeeRecord>(
        `/v1/companies/${ctx.companyUuid}/employees`,
        pg.body,
      );
      // `complete` only means the walk reached the last page. A summary built from
      // `items` only reflects the whole roster when the walk also started at page 1;
      // a `--cursor <pageN>` resume that lands on the end would otherwise emit
      // counts that under-report by pages 1..N-1.
      const coversAll = complete && pg.body.startPage === 1;
      return {
        ok: true,
        data: buildEmployeeList(items, parsed.status, coversAll),
        next: pg.body.surfaceNext ? next : undefined,
      };
    });
  };
}

export type EmployeeStatus = "active" | "onboarding" | "terminated" | "all";

const EMPLOYEE_STATUSES: EmployeeStatus[] = ["active", "onboarding", "terminated", "all"];

export type StatusParseResult = { ok: true; status: EmployeeStatus } | { ok: false; reason: string };

/** Validate the --status value, defaulting to "active" when unset. */
export function parseStatus(raw: string | undefined): StatusParseResult {
  const value = raw ?? "active";
  if ((EMPLOYEE_STATUSES as string[]).includes(value)) return { ok: true, status: value as EmployeeStatus };
  return { ok: false, reason: `must be one of: ${EMPLOYEE_STATUSES.join(", ")}, got: ${value}` };
}

interface EmployeeRecord {
  terminated?: boolean;
  onboarding_status?: string;
  [key: string]: unknown;
}

export interface EmployeeBuckets {
  active: EmployeeRecord[];
  onboarding: EmployeeRecord[];
  terminated: EmployeeRecord[];
}

/** Partition employees into active / onboarding / terminated. Terminated takes
 * precedence; a non-terminated employee is active only once onboarding is complete. */
export function bucketEmployees(employees: EmployeeRecord[]): EmployeeBuckets {
  const buckets: EmployeeBuckets = { active: [], onboarding: [], terminated: [] };
  for (const employee of employees) {
    if (employee.terminated === true) {
      buckets.terminated.push(employee);
    } else if (employee.onboarding_status === "onboarding_completed") {
      buckets.active.push(employee);
    } else {
      buckets.onboarding.push(employee);
    }
  }
  return buckets;
}

export interface EmployeeListSummary {
  total: number;
  active: number;
  onboarding: number;
  terminated: number;
  filter_applied: EmployeeStatus;
}

export interface EmployeeListData {
  summary?: EmployeeListSummary;
  employees: EmployeeRecord[];
}

/** Shape the list response: the `--status` subset in `employees`, plus a full
 * active/onboarding/terminated breakdown in `summary` - included only when
 * `coversAll` is true, meaning `items` represents the entire company roster (the
 * walk started at page 1 *and* reached the end). A partial page or a cursor-resumed
 * walk yields `summary === undefined` so the partial counts are never mistaken for
 * company totals. A non-array body (empty or malformed 200) yields an empty list. */
export function buildEmployeeList(body: unknown, status: EmployeeStatus, coversAll: boolean): EmployeeListData {
  const employees = Array.isArray(body) ? (body as EmployeeRecord[]) : [];
  const buckets = bucketEmployees(employees);
  const selected = status === "all" ? employees : buckets[status];
  if (!coversAll) return { employees: selected };
  const summary: EmployeeListSummary = {
    total: employees.length,
    active: buckets.active.length,
    onboarding: buckets.onboarding.length,
    terminated: buckets.terminated.length,
    filter_applied: status,
  };
  return { summary, employees: selected };
}
