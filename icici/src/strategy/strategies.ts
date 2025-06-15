import BiDirectionStrategy from "./BiDirectionStrategy";
import DiffStrategy from "./DiffStrategy";
import HighLotStrategy from "./HighLotStrategy";
import PivotStrategy from "./PivotStrategy";
import { Strategy } from "./strategy";

const strategies: Array<Strategy> = [
    // new PivotStrategy(),
    // new DiffStrategy(),
    // new HighLotStrategy()
    new BiDirectionStrategy()
];

export { strategies }