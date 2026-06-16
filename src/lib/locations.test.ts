import { describe, expect, test } from "bun:test";
import { fetchCompanyLocations, type LocationRec, pickPrimaryLocation } from "./locations.ts";
import { stubApiClient } from "./test-support.ts";

describe("pickPrimaryLocation", () => {
  test("returns undefined for an empty list", () => {
    expect(pickPrimaryLocation([])).toBeUndefined();
  });

  test("prefers an explicit primary: true", () => {
    const locs: LocationRec[] = [{ uuid: "a", filing_address: true }, { uuid: "b", primary: true }, { uuid: "c" }];
    expect(pickPrimaryLocation(locs)?.uuid).toBe("b");
  });

  test("falls back to filing_address: true when no primary flag is set", () => {
    const locs: LocationRec[] = [{ uuid: "a" }, { uuid: "b", filing_address: true }];
    expect(pickPrimaryLocation(locs)?.uuid).toBe("b");
  });

  test("falls back to the first record when neither flag is set", () => {
    const locs: LocationRec[] = [{ uuid: "a" }, { uuid: "b" }];
    expect(pickPrimaryLocation(locs)?.uuid).toBe("a");
  });
});

describe("fetchCompanyLocations", () => {
  test("returns the list of locations", async () => {
    const { client } = stubApiClient({
      "GET /v1/companies/co-1/locations": [200, [{ uuid: "loc-1", street_1: "300 3rd St" }]],
    });
    const locs = await fetchCompanyLocations(client, "co-1");
    expect(locs).toEqual([{ uuid: "loc-1", street_1: "300 3rd St" }]);
  });

  test("tolerates a non-array (malformed 200) by returning an empty list", async () => {
    const { client } = stubApiClient({
      "GET /v1/companies/co-1/locations": [200, { not: "an array" }],
    });
    const locs = await fetchCompanyLocations(client, "co-1");
    expect(locs).toEqual([]);
  });
});
