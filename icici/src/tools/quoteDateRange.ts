import moment from 'moment';
import 'moment-timezone';

// NiftyQuote/SensexQuote documents (written by NiftyQuote.fromAnt() /
// SensexQuote.fromAnt(), see src/model/model.ts, from src/ant/AntStream.ts
// and src/processes/data/AntDataStream.ts) do not carry a `date` field -
// only `ltt`, a Unix-epoch-seconds tick timestamp (ANT's `ft` field, stored
// as whatever type arrives over the websocket - see the $toDouble usage
// below). To filter by trading day, compute the day's [start, end) epoch-
// second bounds in IST (Asia/Kolkata - the exchange's timezone) and match
// `ltt` against that range instead of an equality match on a field that
// doesn't exist.

export interface DayBounds {
    start: number; // inclusive, Unix epoch seconds, 00:00:00 IST of dateStr
    end: number;   // exclusive, Unix epoch seconds, 00:00:00 IST of the next day
}

// dateStr must be 'YYYY-MM-DD'.
export function dayBoundsIST(dateStr: string): DayBounds {
    const start = moment.tz(dateStr, 'YYYY-MM-DD', 'Asia/Kolkata').startOf('day').unix();
    const end = moment.tz(dateStr, 'YYYY-MM-DD', 'Asia/Kolkata').add(1, 'day').startOf('day').unix();
    return { start, end };
}

// Mongo filter matching NiftyQuote/SensexQuote documents whose `ltt` falls
// within the given trading day (IST). Uses $expr + $toDouble because `ltt`
// may be stored as either a string or a number depending on write path -
// $toDouble normalizes both before the range comparison, so the filter is
// correct either way.
export function dateRangeQuery(dateStr: string): object {
    const { start, end } = dayBoundsIST(dateStr);
    return {
        $expr: {
            $and: [
                { $gte: [{ $toDouble: '$ltt' }, start] },
                { $lt: [{ $toDouble: '$ltt' }, end] },
            ],
        },
    };
}
