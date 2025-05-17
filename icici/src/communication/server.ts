import net from 'net'
import JsonSocket from 'json-socket'
import socket from 'socket.io'
import fs from 'fs'
import { VirtualTrade, Trade } from '../tools/virtual_trade';
import Mongo from '../tools/mongo';
import moment from 'moment';
import { Parser } from 'json2csv';


export default class Server {
    port = 9838; //The same port that the server is listening on
    host = '127.0.0.1';
    socket
    static instance: Server
    vt = new VirtualTrade()
    writeStream
    tradesPath = '/home/karthikeyan/Desktop/github/work/icici/data/trades.csv'

    constructor() {
        const server = net.createServer();
        server.listen(this.port);
        console.log('Server is listening in the port ', this.port)
        fs.unlinkSync(this.tradesPath)
        this.writeStream = fs.createWriteStream(this.tradesPath, { flags: 'a' });
        this.writeStream.write('strategy, symbol, strikePrice, action, price, date, time' + '\n')

        server.on('connection', (netSocket) => { //Don't send until we're connected
            this.socket = new JsonSocket(netSocket); //Decorate a standard net.Socket with JsonSocket
            this.socket.on('message', (message) => {
                this.processMessage(message)
            });
        });
        Server.instance = this
    }

    static start() {
        if (!Server.instance) {
            Server.instance = new Server();
        }
        return Server;
    }

    arrayToCSV = (obj) => {
        return `${Object.values(obj).map(value => `"${value}"`).join(",")}`;
    }

    trades = []
    async processMessage(message) {
        if (message.report) {
            console.log(this.vt.pl())
            process.exit(0)
        } else {
            const added = this.vt.addTrade(message.strategy, message.action, message.symbol, message.strikePrice, message.price)

            const trade = new Trade(message.strategy, message.action, message.symbol, message.strikePrice, message.price)
            const now = new Date();
            trade.date = moment(now).format('DD-MMM-YYYY')
            trade.time = moment(now).format('HH:mm')

            if (added) {
                const mongo = new Mongo()
                Mongo.getInstance().insert(trade)
                Mongo.getInstance().close()
                this.trades.push(trade)
                this.writeStream.write(this.arrayToCSV(trade) + '\n')
            }
        }
    }
}

Server.start()