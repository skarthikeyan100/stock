import Config from './prism/config';

var contractList: String[]  = [];
var tradesCount = 0;


export function removeOrder(contract) {
    console.log('Remove order called for ' + contract);
    if (exists(contract)) {
        console.log('Remove order: ' + contract)
        contractList = contractList.filter(item => item !== contract);
        console.log('After Remove order: ' + contract + ' list: ' + contractList)
    }
    
}

export function addOrder(contract) {
    console.log('Add order called for ' + contract);
    if (!exists(contract)) {
        console.log('Add order: ' + contract)
        tradesCount++;
        contractList.push(contract)
    } 
}

export function exists(contract) {
    if (tradesCount >= Config.totalTradesPerDay) {
        console.log('Total trades per day is reached: ' + tradesCount);
        return true; // Denies further trades
    }
    return contractList.includes(contract)
}

export function hasExceededTrades() {
    if (tradesCount >= Config.totalTradesPerDay) {
        console.log('Total trades per day is reached: ' + tradesCount);
        return true; // Denies further trades
    }
}
