import BiDirectionStrategy from "./BiDirectionStrategy";
import DiffStrategy from "./DiffStrategy";
import PivotStrategy from "./PivotStrategy";
import { Strategy } from "./strategy";

const strategies: Array<Strategy> = [
    // new PivotStrategy(),
    // new DiffStrategy(),
    new BiDirectionStrategy()
];

export { strategies }