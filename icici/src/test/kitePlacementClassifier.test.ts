/** classifyKitePlacementError: definite refusals are marked not-placed, network/unknown failures stay may-be-live. */
import assert from 'assert';
import { classifyKitePlacementError } from '../kite/Kite';
import { isNotPlaced } from '../util/notPlaced';

const live = (e: any) => !!e?.orderMayBeLive && !isNotPlaced(e);
const refused = (e: any) => isNotPlaced(e) && !e?.orderMayBeLive;

for (const t of ['InputException', 'TokenException', 'PermissionException', 'MarginException', 'OrderException']) {
    assert.ok(refused(classifyKitePlacementError({ error_type: t, message: 'x' })), `${t} is a definite refusal`);
}
assert.ok(refused(classifyKitePlacementError(new TypeError('x'))), 'local TypeError');
assert.ok(refused(classifyKitePlacementError(new RangeError('x'))), 'local RangeError');
assert.ok(live(classifyKitePlacementError({ error_type: 'NetworkException', message: 'No response from server with error code: ECONNABORTED' })), 'NetworkException');
for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ESOCKETTIMEDOUT', 'EAI_AGAIN']) {
    assert.ok(live(classifyKitePlacementError(Object.assign(new Error('socket'), { code }))), `${code} may be live`);
}
assert.ok(live(classifyKitePlacementError(new Error('timeout of 7000ms exceeded'))), 'timeout message');
assert.ok(live(classifyKitePlacementError(Object.assign(new TypeError('timeout of 7000ms exceeded'), {}))), 'a TypeError that says timeout stays may-be-live');
assert.ok(live(classifyKitePlacementError(Object.assign(new TypeError('x'), { request: {} }))), 'TypeError after the request was made stays may-be-live');
assert.ok(live(classifyKitePlacementError({ error_type: 'GeneralException', message: 'x' })), 'GeneralException unclassifiable -> may be live');
assert.ok(live(classifyKitePlacementError({ error_type: 'DataException', message: 'x' })), 'DataException unclassifiable -> may be live');
assert.ok(live(classifyKitePlacementError(new Error('something odd'))), 'untyped error -> may be live');
assert.ok(live(classifyKitePlacementError('a string')), 'non-object rejection -> may be live');
assert.ok(refused(classifyKitePlacementError({ error_type: 'NetworkException', message: 'Too Many Requests' })), 'SDK-wrapped 429 -> not placed');
assert.ok(live(classifyKitePlacementError({ error_type: 'GeneralException', message: 'Too many requests' })), 'rate-limit text on a non-NetworkException stays may-be-live');
assert.ok(live(classifyKitePlacementError(new Error('Too many requests'))), 'untyped error with rate-limit text stays may-be-live');
assert.ok(refused(classifyKitePlacementError({ error_type: 'NetworkException', message: 'x', response: { status: 429 } })), 'numeric 429 in response.status -> not placed');
assert.ok(refused(classifyKitePlacementError(Object.assign(new Error('x'), { status: 429 }))), 'numeric 429 in status -> not placed');
assert.ok(live(classifyKitePlacementError({ error_type: 'NetworkException', message: 'No response from server with error code: ECONNRESET' })), 'plain ECONNRESET NetworkException -> may be live');
assert.ok(live(classifyKitePlacementError({ error_type: 'GeneralException', message: 'Unknown error' })), 'GeneralException -> may be live');
const already = classifyKitePlacementError({ error_type: 'OrderException', message: 'x' });
assert.strictEqual(classifyKitePlacementError(already), already, 'an already-marked error passes through');
console.log('kitePlacementClassifier: all passed');
