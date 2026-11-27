import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests must never write into the real logs/ folder.
export default defineConfig({
  test: { env: { GOPOCKET_LOG_DIR: path.join(os.tmpdir(), 'gopocket-test-logs') } },
});
