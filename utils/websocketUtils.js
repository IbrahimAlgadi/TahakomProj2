// Store connected clients
const clients = new Set();
// Map to store subscribers for realtime event
const subscribers = new Set();

function emitEventToClients(event, data) {
    const message = JSON.stringify({ event, data });
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

module.exports = { emitEventToClients, clients };