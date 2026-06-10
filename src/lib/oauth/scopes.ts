/** Parse a space-delimited OAuth scope string into a sorted, de-duped list. */
export function parseScopes(scope: string | undefined | null): string[] {
  if (!scope) return [];
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

export interface ResourceCapability {
  /** The resource segment of a scope, e.g. "employees" from "employees:read". */
  resource: string;
  /** The actions held on that resource, sorted, e.g. ["manage", "read", "write"]. */
  access: string[];
}

/** Group a granted scope set by resource for display. Scopes without an action
 * segment (e.g. "public") are skipped - they don't describe a resource capability. */
export function summarizeGrantedScopes(granted: string[]): ResourceCapability[] {
  const byResource = new Map<string, Set<string>>();
  for (const s of granted) {
    // lastIndexOf so a future multi-segment resource (e.g. "a:b:read") keys on everything before the final colon.
    const idx = s.lastIndexOf(":");
    if (idx <= 0 || idx === s.length - 1) continue;
    const resource = s.slice(0, idx);
    const action = s.slice(idx + 1);
    let actions = byResource.get(resource);
    if (!actions) {
      actions = new Set();
      byResource.set(resource, actions);
    }
    actions.add(action);
  }
  return [...byResource.entries()]
    .map(([resource, actions]) => ({ resource, access: [...actions].sort() }))
    .sort((a, b) => a.resource.localeCompare(b.resource));
}
