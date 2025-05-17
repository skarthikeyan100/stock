import net from 'net'
import JsonSocket from 'json-socket'
import fs from 'fs'
import delay from 'delay';
import { Socket } from 'dgram';

export class Client {
    port = 9838; //The same port that the server is listening on
    host = '127.0.0.1';

    constructor(port) {
        this.port = port
    }
    sendMessage = (message) => {
        // console.log(message)
        JsonSocket.sendSingleMessage(this.port, this.host, message, null)
    }

    sendAndReceive = (message): Promise<any> => {
        console.log('sendAndReceive called')
        return new Promise((resolve, reject) => {
            console.log('Sending message now')
            JsonSocket.sendSingleMessageAndReceive(this.port, this.host, message, (err, message) => {
                console.log('Received MEssage ', message)
                resolve(message.result)
            })
        })
    }
}

