export class Signal {

    bollingerbands = (currentPrice, period, stddev, prices) => {
        let bb = bollingerbands(
            {
                period: period,
                stdDev: stddev, values: prices
            })[0]
        const middle = Math.round(bb.middle)
        const upper = Math.round(bb.upper)
        const lower = Math.round(bb.lower)

        if (currentPrice >= upper) {
            return 'tagUpper'
        }

        if (currentPrice <= lower) {
            return 'tagLower'
        }

    }
}