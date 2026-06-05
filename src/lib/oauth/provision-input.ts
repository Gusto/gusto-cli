export interface ProvisionPayload {
  user: Record<string, unknown>;
  company: Record<string, unknown>;
}

export const EXAMPLE_PAYLOAD: ProvisionPayload = {
  user: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", phone: "5105550100" },
  company: {
    name: "Analytical Engines LLC",
    trade_name: "Analytical Engines",
    ein: "00-1234567",
    number_employees: 1,
    states: ["CA"],
    addresses: [
      {
        street_1: "548 Market St",
        street_2: "",
        city: "San Francisco",
        state: "CA",
        zip: "94104",
        phone: "5105550100",
        is_primary: true,
      },
    ],
  },
};

export class InputError extends Error {}

interface InputFlags {
  input?: string;
  example?: boolean;
}

export async function resolveProvisionPayload(
  flags: InputFlags,
  readFile: (path: string) => Promise<string>,
): Promise<ProvisionPayload> {
  if (flags.input && flags.example) {
    throw new InputError("pass either --input or --example, not both");
  }
  if (flags.example) return EXAMPLE_PAYLOAD;
  if (!flags.input) {
    throw new InputError("provide --input <file.json> with a {user, company} payload, or --example for a sample run");
  }

  let text: string;
  try {
    text = await readFile(flags.input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InputError(`cannot read --input file ${flags.input}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InputError(`--input file ${flags.input} is not valid JSON: ${msg}`);
  }

  return validatePayload(parsed);
}

function validatePayload(parsed: unknown): ProvisionPayload {
  if (typeof parsed !== "object" || parsed === null) {
    throw new InputError("--input must be a JSON object with `user` and `company`");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.user !== "object" || obj.user === null) {
    throw new InputError("--input is missing the `user` object");
  }
  if (typeof obj.company !== "object" || obj.company === null) {
    throw new InputError("--input is missing the `company` object");
  }
  return { user: obj.user as Record<string, unknown>, company: obj.company as Record<string, unknown> };
}
