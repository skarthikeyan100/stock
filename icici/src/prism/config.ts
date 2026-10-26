import Log from '../util/Log';
import fs from 'fs';
import readLine from 'readline';
import path from 'path';


class Config {
    // "endpoint ="http=//rama.kambala.co.in=6002/NorenWClient/",    
    endpoint = "https://api.shoonya.com/NorenWClientAPI/"
    websocket = "wss://api.shoonya.com/NorenWSAPI/"
    eodhost = "http=//kurma.kambala.co.in/chartApi/getdata/"
    debug = true
    timeout = 7000
    heartbeat = 3000
    
    NFOSymbolsPath = path.join(__dirname, '../../data/prism/NFO_symbols.txt')
    stocksPath = 'stocks.csv'

    startHour = 10
    startMin = 0
    endHour = 15
    endMin = 0

    lotCount = 40// Only if lotCount is -1, use investmentAmount
    investmentAmount = 20000
    maxInvestment = 50000
    totalTradesPerDay = 10
    
    auto = false
    takePositionInOtherDirection = true
    
    buyAgainPriceDiff = 20
    buyTrail = 40 // Ideally should be 2x of buyAgainPrice

    trailStop = true
    optionDirection = "OTM" // OTM is lesser price
    depth = 0 // TODO= Change every day. On the day of expiry, it should be 0
    bidirection = false // buy both call and put
    selectedOption = "none" // if "call" buy call, if "put" buy put, otherwise calculate. applicable only if bidirection is false
    //TODO= Buy only when price is low when compared to index value


    file = __dirname + '/../../config/config.properties'
    _processFile = async () => {
      Log.log("Dir Name: " + __dirname);
      Log.log("File Name: " + __filename);
        //If matches exact requested token, then return it
        var lineReader = readLine.createInterface({
          input: fs.createReadStream(this.file)
      });

      try {
          for await (const line of lineReader) {
            const trimmed = line ? line.trim() : '';
            if (!trimmed || trimmed.startsWith('#')) continue;
            // Split on the FIRST '=' only (values may contain '='); a line without '=' is skipped,
            // not fatal for the rest of the file.
            const eq = trimmed.indexOf('=');
            if (eq <= 0) continue;
            const key = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim();
            if (value === 'true' || value === 'false') {
              this[key] = value === 'true';
            } else if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
              this[key] = Number(value);
            } else if (key === 'NFOSymbolsPath') {
              this[key] = path.resolve(path.join(__dirname, '../..'), value);
            } else {
              this[key] = value;
            }
          }
      } catch (e) {
          Log.log(e);
      } finally {
          lineReader.close();
      }
      Log.log("lot count: " + this.lotCount);
      Log.log("Auto Trade: " + this.auto);


    }
    watch = async () => {
      fs.watchFile( 
        this.file, 
        //modify the behaviour of the method 
        { 
          // Specify the use of big integers 
          // in the Stats object  
          bigint: false, 
        
          // Specify if the process should  
          // continue as long as file is 
          // watched 
          persistent: true, 
        
          // Specify the interval between 
          // each poll the file 
          interval: 4000, 
        }, 
        async (curr, prev) => { 
          // Show the time when the file was modified 
          Log.log("Updated configuration at ", curr.mtime); 
          await this._processFile();
        } 
      ); 
    }
  }

  const config = new Config()
  config._processFile()
  config.watch()
  
  export default config