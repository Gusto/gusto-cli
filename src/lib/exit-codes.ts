export const ExitCode = {
  Success: 0,
  General: 1,
  CliUsage: 2,
  Auth: 3,
  ApiClient: 4,
  ApiServer: 5,
  Network: 6,
  Validation: 7,
  Blocked: 8,
  Timeout: 9,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
