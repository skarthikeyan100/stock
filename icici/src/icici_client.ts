import net from 'net'
import JsonSocket from 'json-socket'
import fs from 'fs'
import delay from 'delay';
import { Socket } from 'dgram';

export class IciciClient {
    port = 5555; //The same port that the server is listening on
    host = '127.0.0.1';

    sendMessage = (message) => {
        console.log(message, ' to ', this.port, this.host)
        JsonSocket.sendSingleMessage(this.port, this.host, message, (err) => {
            console.log('Message is sent, error: ', err)
        })
    }
}

const client = new IciciClient()
client.sendMessage({ command: 'getOpenPositions' })

setInterval(() => { }, 1 << 30);
