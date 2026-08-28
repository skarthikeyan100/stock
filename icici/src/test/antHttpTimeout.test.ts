/**
 * Verifies ANT's shared axios instance is configured with a default request
 * timeout, so a hung connection to AliceBlue can no longer stall a caller
 * (e.g. a strategy awaiting order placement, via OrderClient -> order
 * process -> ANT) forever. A real network hang isn't practically
 * unit-testable without a mock HTTP server - see
 * plans/bug-09-no-timeout-broker-http-ipc.md's Verification section for a
 * manual live-check instead. This asserts the instance-level config that
 * every axios.get/axios.post call in ANT.ts relies on.
 * Run: npm run build (compile), then: node ./dist/test/antHttpTimeout.test.js
 */

import { ANT_HTTP_TIMEOUT_MS, antAxiosInstance } from '../ant/ANT';

function assert(condition: boolean, message: string) {
    if (condition) {
        console.log(`  PASS: ${message}`);
    } else {
        console.log(`  FAIL: ${message}`);
        process.exitCode = 1;
    }
}

async function main() {
    assert(ANT_HTTP_TIMEOUT_MS > 0, `ANT_HTTP_TIMEOUT_MS is a positive number (got ${ANT_HTTP_TIMEOUT_MS})`);
    assert(
        ANT_HTTP_TIMEOUT_MS >= 10000 && ANT_HTTP_TIMEOUT_MS <= 20000,
        `ANT_HTTP_TIMEOUT_MS is in the expected 10-20s range (got ${ANT_HTTP_TIMEOUT_MS})`
    );
    assert(
        antAxiosInstance.defaults.timeout === ANT_HTTP_TIMEOUT_MS,
        `ANT's shared axios instance has timeout=${ANT_HTTP_TIMEOUT_MS} set on its defaults (got ${antAxiosInstance.defaults.timeout})`
    );

    if (process.exitCode === 1) {
        console.log('SOME TESTS FAILED');
    } else {
        console.log('ALL TESTS PASSED');
    }
}

main();
