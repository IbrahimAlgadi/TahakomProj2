# Process Monitor Page

This document outlines the features of the Process Monitor page, which provides a real-time view of system processes and their resource consumption.

## 1. Header Controls

The header contains controls for refreshing and organizing the process list.

### Features:

-   **Refresh Button**: Manually reloads the list of processes.
-   **Sorting Controls**: Allows sorting the process cards by `Name`, `CPU` usage, or `Memory` usage.

## 2. Process Grid

This section displays a grid of cards, with each card representing a monitored system process.

### Features:

-   **Process Cards**: Each card provides a summary of a process's status.
-   **Information on Cards**:
    -   **Process Name & PID**: The name of the process and its main Process ID (PID).
    -   **CPU Usage**: A progress bar and percentage value showing CPU consumption. The bar is color-coded (green/yellow/red) to indicate high usage.
    -   **Memory Usage**: A progress bar and percentage value for memory consumption, also color-coded.
    -   **Child Processes**: A count of the number of child processes.
    -   **View Details Button**: A button to open a modal with more detailed information.

## 3. Process Details Modal

Clicking "View Details" on a process card opens a modal window with in-depth information.

### Features:

-   **Resource Usage Overview**: Displays CPU and Memory usage with large, clear progress bars.
-   **Process Information**: A summary including the Process Name, Main PID, Total PID count, and a "Last Updated" timestamp.
-   **Child Process List**:
    -   A table listing all child processes associated with the main process.
    -   Includes columns for `PID` and `Status`.
    -   A search bar to quickly find a specific PID within the list.

## 4. Real-time Updates & Notifications

-   **WebSockets**: The page uses a WebSocket connection to receive live process data, ensuring the CPU, memory, and other stats are continuously updated without needing a manual refresh.
-   **Toast Notifications**: The system can display toast notifications for important events or alerts.

## How to Use:

1.  **View Processes**: Open the page to see a live grid of monitored processes.
2.  **Sort Processes**: Use the sorting buttons in the header to organize the processes by name, CPU, or memory usage to easily identify resource-intensive tasks.
3.  **Get More Details**: For any process, click the "View Details" button to open the modal.
4.  **Analyze in Modal**: In the modal, review the detailed resource usage and inspect the list of child processes. Use the search bar if you need to find a specific child PID.
5.  **Refresh Manually**: If necessary, click the "Refresh" button in the header. 