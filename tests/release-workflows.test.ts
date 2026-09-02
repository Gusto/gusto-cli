import { describe, expect, test } from "bun:test";

type Workflow = {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
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

  test("serializes both publishers through one repository-wide publication group", async () => {
    const legacy = await workflow("release.yml");
    const sealed = await workflow("release-publish.yml");
    const expected = { group: "release-publication", "cancel-in-progress": false };

    expect(legacy.concurrency).toEqual(expected);
    expect(sealed.concurrency).toEqual(expected);
  });

  test("uses the tag endpoint only for published observation and a bounded listing plus ID lookup for drafts", async () => {
    const sealed = await workflow("release-publish.yml");
    const script = Object.values(sealed.jobs ?? {})
      .flatMap((job) => (job as { steps?: Array<{ run?: string }> }).steps ?? [])
      .map((step) => step.run ?? "")
      .join("\n");

    expect(script).toContain("releases/tags/$tag");
    expect(script).toContain("releases?per_page=100&page=$page");
    expect(script).toContain("releases/$release_id");
  });
});
