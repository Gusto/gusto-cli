import type { StreamSinks } from "./output.ts";

export interface CapturedStream {
  buffer: string;
  sink: NodeJS.WritableStream;
}

export function captureStream(): CapturedStream {
  const captured: CapturedStream = {
    buffer: "",
    sink: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal WritableStream stub for tests
      write(chunk: any) {
        captured.buffer += String(chunk);
        return true;
      },
    } as NodeJS.WritableStream,
  };
  return captured;
}

export function captureSinks(): { sinks: StreamSinks; stdout: CapturedStream; stderr: CapturedStream } {
  const stdout = captureStream();
  const stderr = captureStream();
  return { sinks: { stdout: stdout.sink, stderr: stderr.sink }, stdout, stderr };
}
