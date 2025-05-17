import net from 'net'
import JsonSocket from 'json-socket'

import Icici from './trade/icici'
import Constants from './communication/constants';

console.log(process.argv)
var args = process.argv.slice(2);
Icici.getUserInstance(args[0], args[1], args[2])

const server = net.createServer();
server.listen(args[3]);
console.log('Server is listening in the port ', args[3])

let socket
server.on('connection', (netSocket) => { //Don't send until we're connected
    console.log('Connected')
    socket = new JsonSocket(netSocket); //Decorate a standard net.Socket with JsonSocket
    let result = {}
    socket.on('message', async (message) => {
        console.log('Message from parent ', message)
        switch (message.command) {
            case Constants.OPTION_PLUS_POSITIONS:
                result = await Icici.instance.getOptionPlusOpenPositions()
                console.log('Result ', result)
                socket.sendEndMessage({ result: result });
                break;
            case Constants.OPTION_POSITIONS:
                result = await Icici.instance.getOptionOpenPositions()
                console.log('Result ', result)
                socket.sendEndMessage({ result: result });
                break;
        }
    });
});

setInterval(() => { }, 1 << 30);
