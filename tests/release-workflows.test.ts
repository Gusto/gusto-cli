import { describe, expect, test } from "bun:test";

type Workflow = {
  on?: Record<string, unknown>;
  jobs?: Record<string, { if?: string; permissions?: Record<string, string> }>;
};

async function workflow(name: string): Promise<Workflow> {
  return Bun.YAML.parse(await Bun.file(`.github/workflows/${name}`).text()) as Workflow;
}

describe("release workflow cutover", () => {
  test("uses complementary job gates so one repository variable atomically selects the only publisher", async () => {
    const legacy = await workflow("release.yml");
    const sealed = await workflow("release-publish.yml");

    expect(legacy.jobs?.release?.if).toBe("${{ vars.RELEASE_AUTOMATION_CUTOVER != 'sealed-v1' }}");
    expect(sealed.jobs?.publish?.if).toBe("${{ vars.RELEASE_AUTOMATION_CUTOVER == 'sealed-v1' }}");
  });

  test("keeps candidate creation manual because the trusted main-push pipeline dispatches it", async () => {
    const candidate = await workflow("release-candidate.yml");

    expect(Object.keys(candidate.on ?? {})).toEqual(["workflow_dispatch"]);
  });

  test("keeps the legacy tag trigger inert after cutover instead of granting another writer", async () => {
    const legacy = await workflow("release.yml");

    expect(legacy.on).toEqual({ push: { tags: ["v*.*.*"] } });
    expect(legacy.jobs?.release?.permissions).toBeUndefined();
  });
});
