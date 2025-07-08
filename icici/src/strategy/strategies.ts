import BiDirectionStrategy from "./BiDirectionStrategy";
import BuySellStrategy from "./BuySellStrategy";
import DiffStrategy from "./DiffStrategy";
import HighLotStrategy from "./HighLotStrategy";
import PivotStrategy from "./PivotStrategy";
import { Strategy } from "./strategy";

let strategies: Array<Strategy> = [
    // new PivotStrategy(),
    // new DiffStrategy(),
    // new HighLotStrategy(),
    new BiDirectionStrategy()
    // new BuySellStrategy()
];


export default strategies