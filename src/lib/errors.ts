/** Best-effort message string from an unknown thrown value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
