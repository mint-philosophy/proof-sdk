import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'src/bridge/collab-client.ts'), 'utf8');

  assert(
    source.includes("private canPersistDurableUpdates(role: ShareRole): boolean")
      && source.includes("return role === 'editor' || role === 'owner_bot';"),
    'Expected role-aware durable-update gate helper with edit-only roles',
  );

  assert(
    source.includes('this.durableUpdatesEnabled = this.canPersistDurableUpdates(session.role);')
      && source.includes('if (this.durableUpdatesEnabled) {')
      && source.includes('this.loadDurableBuffer(session.slug);')
      && source.includes('this.resetDurableState();'),
    'Expected connect() to role-gate durable buffer load/replay',
  );

  assert(
    source.includes('if (!this.durableUpdatesEnabled || !this.durableBufferKey) return;')
      && source.includes('if (!this.durableUpdatesEnabled) return;\n    if (this.durablePendingUpdates.length === 0) return;')
      && source.includes('if (!this.durableUpdatesEnabled) return;\n    if (this.connectionStatus !== \'connected\') return;'),
    'Expected durable append/replay/clear paths to stay role-gated while always replaying buffered local updates on reconnect',
  );

  console.log('✓ commenter durable-replay guard regression');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
