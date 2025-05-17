
import axios from 'axios'
import fs from 'fs'
import moment from 'moment'

console.log('BhavCopy')

const fetchBhavCopy = async () => {

    let now = moment()

    for (let i = 0; i < 180; i++) {
        now.subtract(1, "days")
        const month = now.format('MMM').toUpperCase();
        const weekday = now.weekday()
        if (weekday == 6 || weekday == 0) {
            continue;
        }
        const date = ("0" + now.get('date')).slice(-2)
        const year = now.get('year')
        const fileName = `cm${date}${month}${year}bhav.csv.zip`
        const url = `https://www1.nseindia.com/content/historical/EQUITIES/${year}/${month}/${fileName}`
        console.log(url)
        try {
            const response = await axios.get(url, { responseType: "stream" })
            await response.data.pipe(fs.createWriteStream(`../bhavcopy/${fileName}`));
    
        } catch (e) {
            console.log('Holiday ', now.format('dd/MMM'))
        }
    }


}

fetchBhavCopy();
