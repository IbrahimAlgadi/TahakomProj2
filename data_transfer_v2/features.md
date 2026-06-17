# Dashboard Features

This document outlines the features of the data transfer dashboard as implemented in `views/dashboard.njk`.

## 1. Core Functionality

- **Data Visualization**: The dashboard provides a visual representation of file transfer and vehicle processing statistics.
- **Dynamic Filtering**: Users can filter the displayed data based on different time frames and parameters.
- **Responsive Charts**: All charts are interactive and resize automatically with the browser window.

## 2. Views

The dashboard supports two main views for data aggregation:

- **Hourly View**: Displays statistics aggregated by the hour for a selected date. This is the default view.
- **Daily View**: Displays statistics aggregated by day over a selected date range.

## 3. Filtering Capabilities

### Hourly Filters
- Filter by a single **Date**.
- Filter by a **Start Hour** and **End Hour** within the selected day.

### Daily Filters
- Filter by a **Start Date** and **End Date** range.
- **Camera Filter**:
    - `All Cameras`: Aggregates data from all cameras.
    - `Per Camera`: (Functionality needs verification) Intended to show data for individual cameras.
    - `Aggregated`: (Functionality needs verification) Likely the default behavior, combining all camera data.

## 4. Statistical Displays

### Key Performance Indicator (KPI) Cards
- **Total Vehicles**: Total count of vehicles detected.
- **Total Files**: Total count of files processed.
- **Success Rate**: The percentage of files that were successfully processed.
- **Total Size**: The total size of all processed files, displayed in GB.

### Charts
- **Files Processing Overview**: A combination line and bar chart showing total files, successfully processed files, and failed files over the selected time frame (hourly or daily).
- **Success Rate Chart**: A pie chart visualizing the ratio of successful to failed files.
- **File Size Distribution**: A bar chart showing the total file size (in GB) for each interval in the selected time frame.
- **Vehicle Count Trend**: A smoothed line chart illustrating the number of vehicles detected over the selected time frame.

## 5. Data Table

- A detailed table provides a raw, non-visual breakdown of the data shown in the charts.
- The columns adjust based on the selected view (Hourly or Daily).
- **Hourly Columns**: Date, Hour, Vehicles, Total Files, Success, Failed, Failed %, Size (GB).
- **Daily Columns**: Date, Vehicles, Total Files, Success, Failed, Failed %, Size (GB).

## 6. User Interface Controls

- **Refresh**: Manually re-fetches and updates the dashboard data.
- **View Toggle**: Switch between Hourly and Daily views.
- **Apply Filters**: Applies the selected filter criteria to the data.
- **Reset Filters**: Reverts filters to their default state (Today for Hourly, last 7 days for Daily).
- **Notifications**: A toast notification system to alert users of events like data loading failures. 