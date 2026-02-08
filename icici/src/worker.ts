import { Candle } from './decision';
import workerpool from 'workerpool';

type PricePoint = { time: number; price: number };

const round = (num) => Math.round(num * 100) / 100;

function processData(workerName: string, sharedBuffer: ArrayBuffer, candles: Candle[]) {
  console.log('Evaluate ', workerName)
  // Reconstruct shared array
  const sharedArray = new Float64Array(sharedBuffer);


  // Convert back into PricePoint objects
  const sharedPoints: PricePoint[] = [];
  for (let i = 0; i < sharedArray.length; i += 2) {
    sharedPoints.push({ time: sharedArray[i], price: sharedArray[i + 1] });
  }

  const evaluatedCandles = labelGoodBad(candles, sharedPoints)
  const successRate = percentageGoodOverBad(evaluatedCandles)

  return {
    worker: workerName,
    sharedCount: sharedPoints.length,
    candlesCount: candles.length,
    successRate
  };
}

workerpool.worker({
  processData
});

function labelGoodBad(data: Candle[], prices: PricePoint[]): Candle[] {
    // console.log('Candle size: ', data.length)
    // console.log('Pricepoint size: ', prices.length)
    let futurePrices = prices;
    return data.map(candle => {
      futurePrices = futurePrices.filter(p => p.time > candle.time)
  
      let label : "none" | "good" | "bad" = "none" 
      let pricePoint;
  
      if (candle.trend === "UP") {
        pricePoint = futurePrices.find(price => price.price > candle.close);
        // console.log('Found label for up ', label)
      } else if (candle.trend === "DOWN") {
        pricePoint = futurePrices.find(price => price.price < candle.close);
        // console.log('Found label for down', label)
      }

      label = pricePoint ? 'good' : 'bad'
  
      return { ...candle, result: label };
    });
  }
  
  function percentageGoodOverBad(data: Candle[]): number {
    const goodCount = data.filter(c => c.result === "good").length;
    const badCount = data.filter(c => c.result === "bad").length;
  
    if (badCount === 0) return Infinity;
    const result = 100 - 100/ (1+goodCount/badCount)
    const another = goodCount / (goodCount + badCount) * 100
    return round(result)
  }

  
