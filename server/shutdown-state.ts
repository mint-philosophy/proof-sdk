// Dedicated module for shutdown state to avoid circular imports between
// server/index.ts and server/ws.ts. Both modules import from here.

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function setShuttingDown(): void {
  shuttingDown = true;
}

export function __unsafeClearShuttingDownForTests(): void {
  shuttingDown = false;
}
