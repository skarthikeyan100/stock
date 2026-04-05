import moment from 'moment';

export default class Log {
  static log(...args: any[]) {
    const message = args.map(a => {
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a, null, 2); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
    const timestamp = moment().format('HH:mm:ss');

    // Capture stack trace
    const stack = new Error().stack;
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
