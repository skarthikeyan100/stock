import BiDirectionStrategy from "./BiDirectionStrategy";
import BuySellStrategy from "./BuySellStrategy";
import DiffStrategy from "./DiffStrategy";
import HighLotStrategy from "./HighLotStrategy";
import IntermittentStrategy from "./IntermittentStrategy";
import Minutes5Decision from "./Minutes5Decision";
import PivotStrategy from "./PivotStrategy";
import SentimentStrategy from "./SentimentStrategy";
import { Strategy } from "./strategy";



class Strategies {
    private list : Array<Strategy> = [
        new Minutes5Decision(),
        // new DiffStrategy(),
        // new HighLotStrategy(),
        // new BiDirectionStrategy(),
        // new BuySellStrategy(),
        // new SentimentStrategy()
    ];

    addToList(strategy: Strategy) {
        this.list.push(strategy);
    }

    getList() { return this.list; }

    private constructor() { 
    }

    static instance: Strategies | null = null;

    static getInstance() {
        if (Strategies.instance == null) {
            Strategies.instance = new Strategies();
        }
        return Strategies.instance;
      }
    
}


export default Strategies.getInstance()