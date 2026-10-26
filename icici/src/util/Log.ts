import moment from 'moment';

const MAX_OBJECT_LOG_CHARS = 6000;

export default class Log {
  static log(...args: any[]) {
    const message = args.map(a => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (typeof a === 'object' && a !== null) {
        try {
          const text = JSON.stringify(a, null, 2);
          // A huge object (full config, trade arrays) on every call is costly and unreadable: cap it.
          return text.length > MAX_OBJECT_LOG_CHARS ? `${text.slice(0, MAX_OBJECT_LOG_CHARS)}... [truncated ${text.length - MAX_OBJECT_LOG_CHARS} chars]` : text;
        } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
    const timestamp = moment().format('HH:mm:ss');

    // Capture stack trace
    // Only the top few frames are needed to name the caller - a full-depth capture on every log line is wasteful.
    const previousLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 4;
    const stack = new Error().stack;
    Error.stackTraceLimit = previousLimit;
    let callerInfo = "unknown";

    if (stack) {
      // Stack lines look like: "at ClassName.methodName (file:line:col)"
      const lines = stack.split("\n");
      if (lines.length >= 3) {
        const callerLine = lines[2].trim(); // line 0 = Error, line 1 = this method, line 2 = caller
        callerInfo = callerLine.replace(/^at\s+/, "").replace(/\s*\(.*\)$/, "");
      }
    }

    console.log(`[${timestamp}] [${callerInfo}] ${message}`);
  }
}
