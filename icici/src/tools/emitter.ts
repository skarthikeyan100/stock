import { EventEmitter } from 'events';

class MyEmitter extends EventEmitter { }

var myEmitter = new MyEmitter();

export default myEmitter;