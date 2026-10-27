import { LegBrokerOps, defaultLegOps } from './LegBrokerOps';
import { antLegOps } from './antLegOps';
import { normalizeBrokerName } from '../util/brokerName';

// The one place a strategy leg's order routing is chosen from its broker name. ANT has its own ops (the generic 'Bare' IPCs
// route by the user's configured broker and refuse ANT's limit buy and contract pick); every other broker uses the default
// per-user routing.
export function legOpsFor(broker: unknown): LegBrokerOps {
    return normalizeBrokerName(broker) === 'ant' ? antLegOps : defaultLegOps;
}
