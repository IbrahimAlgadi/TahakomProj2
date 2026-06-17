# FTP/SFTP Transfer Page

This document describes the features of the FTP/SFTP Transfer page, which is used for configuring and monitoring remote file transfers.

## 1. Server Configuration

This section allows you to set up the connection to an FTP or SFTP server.

### Features:

-   **Protocol Selection**: Choose between `FTP` and `SFTP` for the transfer.
-   **Server Details**:
    -   **Server Host**: The address of the FTP/SFTP server.
    -   **Port**: The port number for the connection (defaults to 21 for FTP).
    -   **Remote Directory**: The target directory on the server where files will be uploaded.
-   **Authentication**:
    -   **Username**: The username for server authentication.
    -   **Password**: The password for server authentication, with a toggle to show/hide the entered password.
-   **Actions**:
    -   **Test Connection**: A button to verify the server details and attempt a connection.
    -   **Save Configuration**: A button to save the server configuration for future use.

## 2. Transfer Status

This section provides real-time monitoring of the file transfer process.

### Features:

-   **Connection Status**: A visual indicator shows whether the application is currently `Connected` to the server.
-   **Transfer Statistics**:
    -   **Files Pending**: The number of files waiting to be transferred.
    -   **Files Transferred**: The total number of files that have been successfully transferred.
    -   **Transfer Speed**: The current data transfer rate (e.g., in MB/s).
-   **Current Transfer Progress**:
    -   **File Name**: The name of the file currently being transferred.
    -   **Progress Bar**: A visual bar showing the progress of the current file transfer.
    -   **Details**: Shows the completion percentage, current speed, and estimated time remaining (ETA).
-   **Start Transfer Button**: A button to initiate the file transfer process.

## How to Use:

1.  **Choose Protocol**: Select either FTP or SFTP.
2.  **Enter Server Details**: Fill in the server host, port, remote directory, username, and password.
3.  **Test Connection**: Click "Test Connection" to ensure the details are correct and the server is reachable.
4.  **Save Configuration**: Once the connection is successful, click "Save Configuration".
5.  **Start Transfer**: Click the "Start Transfer" button to begin uploading files.
6.  **Monitor Progress**: Observe the transfer status, statistics, and current progress in the "Transfer Status" card. 