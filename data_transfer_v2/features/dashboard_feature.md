# Dashboard Page

This document outlines the features available on the Dashboard page, which provides a comprehensive overview of data processing and system performance.

## 1. Header Controls

The header section provides main controls for the dashboard's data view and export capabilities.

### Features:

-   **Refresh Button**: Manually reloads the dashboard data to get the latest statistics.
-   **View Toggle**: Allows switching the data aggregation period between `Hourly`, `Daily`, `Monthly`, and `Yearly` views.
-   **Export Options**: A dropdown menu to export the displayed data in various formats:
    -   `PDF`
    -   `JSON`
    -   `XML`
    -   `Daily Operation Report (JSON)`
    -   `Daily Operation Report (XML)`

## 2. Filters

The filter section allows for refining the data presented on the dashboard.

### Features:

-   **Dynamic Filters**: A container for various filter controls that are dynamically added based on the available data.
-   **Apply Filters**: Applies the selected filter criteria to all dashboard components (charts, stats, table).
-   **Reset Filters**: Clears all applied filters and restores the default view.

## 3. Statistics Cards

A series of cards at the top of the page display key performance indicators (KPIs) at a glance.

### KPIs Displayed:

-   **Total Vehicles**: The total number of vehicles processed.
-   **Total Files**: The total number of files processed.
-   **Avg. Speed**: The average speed of the vehicles.
-   **Success Rate**: The percentage of successfully processed files.
-   **Total Size**: The total size of all processed files.

## 4. Charts

The dashboard includes several charts for visual analysis of the data.

### Available Charts:

-   **Files Processing Overview**: A line chart (`mainChart`) showing trends in file processing over the selected time period.
-   **Success Rate**: A pie chart (`successChart`) illustrating the proportion of successful versus failed processing.
-   **File Size Distribution**: A bar chart (`fileSizeChart`) showing the distribution of file sizes.
-   **Vehicle Count Trend**: An area chart (`vehicleChart`) displaying the trend of vehicle counts over time.

## 5. Detailed Data Table

A table at the bottom of the page provides a detailed, granular view of the data.

### Features:

-   **Dynamic Data**: The table headers and rows are dynamically populated based on the fetched data and applied filters.
-   **Responsive**: The table is designed to be responsive for viewing on different screen sizes.

## 6. Notifications

-   **Toast Notifications**: The page uses toast notifications to display non-intrusive messages, for example, after a successful data refresh or an error.

## How to Use:

1.  **Select a View**: Choose a time frame (Hourly, Daily, etc.) from the top toggle buttons.
2.  **Filter Data (Optional)**: Use the filters section to narrow down the data. Click "Apply Filters".
3.  **Analyze Data**: View the high-level statistics on the cards and analyze trends using the various charts.
4.  **View Details**: For more detailed information, refer to the data table at the bottom.
5.  **Export Data**: If needed, export the data using the "Export" button in the header.
6.  **Refresh**: Click the "Refresh" button to get the most up-to-date data. 