# Auto Transfer Microservice

This microservice handles the auto transfer functionality for the data transfer system. It provides endpoints for configuring and managing automatic file transfers.

## Features

- Drive configuration and testing
- Encryption settings management
- Auto transfer status toggle
- Real-time status updates via WebSocket

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the microservice:
```bash
npm start
```

The service will run on port 8990.

## API Endpoints

- `GET /auto-transfer/config` - Get current auto transfer configuration
- `POST /auto-transfer/test-drive` - Test if a drive is connected and has sufficient space
- `POST /auto-transfer/save-config` - Save auto transfer configuration
- `POST /auto-transfer/toggle` - Toggle auto transfer status

## WebSocket Events

The service provides real-time updates through WebSocket connection on `ws://localhost:8990`. Events include:
- `handleAutoTransfer` - Real-time updates about transfer status and drive information
