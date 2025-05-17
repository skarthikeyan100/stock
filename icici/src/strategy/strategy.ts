import { NiftyQuote, Trade } from "model/model";

export enum Outcome {
    WAIT = "WAIT",
    CALL = "CALL",
    PUT = "PUT",
    PENDING_CLOSURE = "PENDING_CLOSURE"
}

export interface Strategy {
    tradeMap : Map<String, Trade>
    name: string
    // process(quote: NiftyQuote, token: String) : Outcome 
    // addTrade(trade: Trade);
    receive(oldStats, newStats);
    process(quote);
}