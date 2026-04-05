import Log from './util/Log';
import Prism from './prism';
import { NiftyQuote, OptionQuote, Trade, Order } from './model/model';
import moment from 'moment'
import * as fs from 'fs';
import delay from 'delay';
import Option from 'trade/option';

const orderQuantity = 900

export class OnTrigger {
    processed = false;
    contract: string;
    triggerPrice: number;
    token: string;

    setTrigger = async (contract, triggerPrice) => {
        this.contract = contract;
        this.triggerPrice = triggerPrice;
        const prism = Prism.getInstance()
        this.token = await prism.getToken(contract)
        await prism.subscribeOption(this.token);
        delay(2000)
    }

    process = async(optionQuote: OptionQuote) => {
        Log.log('Trigger Option Quote: ', this.contract, ' trigger: ', this.triggerPrice, ' ltp: ', optionQuote.ltp);
        if (!this.processed && optionQuote.token === this.token && optionQuote.ltp >= this.triggerPrice) {
            const prism = Prism.getInstance()
            // prism.buyContract(this.contract, orderQuantity, this.triggerPrice)
            this.processed = true;
        }
    }
}

const onTrigger = new OnTrigger();
export default onTrigger;

