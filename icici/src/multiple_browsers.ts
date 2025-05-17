import net from 'net'
import JsonSocket from 'json-socket'
import Icici from './trade/icici';
import { exec, ChildProcess } from 'child_process';
import { Client } from './communication/client';


import http from 'http'
import url from 'url'
import { getOpenPositions } from 'functions';

console.log('Server is listening at 8080')




export default class MultipleBrowsers {
    port = 5555; //The same port that the server is listening on
    host = '127.0.0.1';
    socket
    karthik: Client;
    raja: Client;
    writeStream
    tradesPath = '/home/karthikeyan/Desktop/github/work/icici/data/trades.csv'

    async init() {

        // this.karthik = fork('node browser WK133843 nivi1000 31081975')
        // this.karthik.stdout.on('data', function(data) {
        //     console.log('[Karthik] ', data.toString()); 
        // });
        // this.karthik.on('exit', function (code) {
        //     console.log('Karthik\'s browser exited with exit code ' + code);
        // });

        const raja = exec('node browser SESHA100 nava1000 22091943 6001')
        raja.stdout.on('data', function (data) {
            console.log('[Raja] ', data.toString());
        });
        raja.stdout.on('error', function (data) {
            console.log('[Raja][Error] ', data.toString());
        });

        raja.on('exit', function (code) {
            console.log('Raja\'s browser exited with exit code ' + code);
        });

        console.log('Initialized')
        this.raja = new Client(6001)
        http.createServer(function (req, res) {
            try {

                var q = url.parse(req.url, true).query;
                var p = url.parse(req.url, true).path;
                var pathName = url.parse(req.url, true).pathname;

                console.log('Query: ', q)
                console.log('Path: ', p)

                console.log('Command ', q.command)
                res.setHeader('Content-Type', 'application/json');
                switch (pathName) {
                    case '/getOpenPositions':
                        console.log('In this path getOpenPositions')
                        const response = this.raja.sendAndReceive({ command: 'getOpenPositions' })
                        console.log('Response ', response)
                        res.write('Hello')
                        res.end()
                        break;
                    default:
                        res.write('Unrecognized URL')
                        res.end()
                }
            } catch (e) {
                res.statusCode = 500;
                res.end(e)
            }

        }).listen(8080);

    }
    constructor() {
        this.init()
    }

    async processMessage(message) {
        console.log('Process message ', message)
        switch (message.command) {
            case 'getOpenPositions':
                await this.raja.sendMessage({ command: 'getOpenPositions' })
                // await this.karthik.send({command: 'getOpenPositions'})
                break;
        }
    }
}

new MultipleBrowsers()
