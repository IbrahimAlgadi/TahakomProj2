let startDay = moment().startOf('day');
let endDay = moment().endOf('day');
// Set the values for the start date and time inputs
$('#startDate').val(startDay.format('YYYY-MM-DD'));
$('#startTime').val(startDay.format('HH:mm'));
// Set the values for the end date and time inputs
$('#endDate').val(endDay.format('YYYY-MM-DD'));
$('#endTime').val(endDay.format('HH:mm'));

// Function to get the values from the inputs as moment objects
function getStartAndEndDateTime() {
    let startDate = $('#startDate').val();
    let startTime = $('#startTime').val();
    let endDate = $('#endDate').val();
    let endTime = $('#endTime').val();

    let startDateTime = moment(`${startDate} ${startTime}`, 'YYYY-MM-DD HH:mm');
    let endDateTime = moment(`${endDate} ${endTime}`, 'YYYY-MM-DD HH:mm');

    return { startDateTime, endDateTime };
}

function downloadFiles(filePaths) {
    filePaths.forEach(filePath => {
        const link = document.createElement('a');
        link.href = filePath;
        link.download = ''; // Optional: Set a filename if needed
        document
            .body
            .appendChild(link);
        link.click();
        document
            .body
            .removeChild(link);
    });
}

// Initialize the table

let url = "/files/data";

$('#filesTable').DataTable({
    serverSide: true,
    processing: true,
    searching: false,
    paging: true,
    searching: false,
    lengthChange: false,
    ordering: false,
    ajax: {
        url: url,
        type: 'GET',
        data: function (d) {
            let { startDateTime, endDateTime } = getStartAndEndDateTime();
            let search = $('#plateNumberSearch').val();
            let startDateFilter = startDateTime.format("YYYY-MM-DD HH:mm:ss");
            let endDateFilter = endDateTime.format("YYYY-MM-DD HH:mm:ss");

            // Send pagination and search data to the server
            d.pageSize = d.length; // Number of records per page
            d.pageNumber = (d.start / d.length) + 1; // Page number
            d.search = search; // Search value
            d.startDate = startDateFilter; // Optional start date filter
            d.endDate = endDateFilter; // Optional end date filter
            // console.log(d);
        },
        dataSrc: function (response) {
            // console.log(response);
            return response.data; // Data returned from server
        }
    },
    columns: [
        {
            data: 'tid',
            render: function (data) {
                return data
                .join('<br>');
            }
        }, {
            data: 'plate_num'
        }, {
            data: 'site_id'
        }, {
            data: 'date',
            render: function (data) {
                return moment(data).format("DD/MM/YYYY");
            }
        }, {
            data: 'time',
            render: function (data) {
                return data;
            }
        }, {
            data: 'file_names',
            render: function (data) {
                return data
                    .join('\n')
                    //.slice(0, 30) + '...';
            }
        }, {
            data: 'file_sizes',
            render: function (data) {
                let total = 0;
                for (let i = 0; i < data.length; i++) {
                    // console.log(data[i]);
                    total += data[i];
                }
                return formatFileSize(total);
            }
        }, {
            data: 'file_sizes', // New "File Count" column based on file_sizes array
            title: 'File Count',
            orderable: false,
            render: function (data) {
                // Count the number of non-zero entries in the file_sizes array
                let count = 0;
                for (let i = 0; i < data.length; i++) {
                    if (data[i] > 0)
                        count++;
                }
                return count;
            }
        }, {
            data: null, // Set to null to access the entire row data
            orderable: false, // Disable ordering on this column
            render: function (data, type, row) {
                const filePaths = row.file_paths; // Access the file_paths array from row data
                const fileSizes = row.file_sizes; // Access the file_paths array from row data
                let count = 0;
                let filesToDownload = [];
                for (let i = 0; i < fileSizes.length; i++) {
                    if (fileSizes[i] > 0) {
                        filesToDownload.push(filePaths[i]);
                        count++;
                    }
                }
                if (Array.isArray(filesToDownload) && filesToDownload.length > 0) {
                    // Convert file paths to a JavaScript-safe array string
                    const formattedPaths = filesToDownload
                        .map(path => path.replace(/\\/g, '/'))
                        .join("','");
                    // Return the "Download All" button
                    return `<button class="btn btn-info download-btn" onclick="downloadFiles(['${formattedPaths}'])">Download (${count})</button>`;
                } else {
                    return "No files available";
                }
            }
        }
    ],
    order: [
        [3, 'desc']
    ], // Order by date descending by default
    dom: 'rtip'
});

$('#filterButton').click(function (e) {
    $('#filesTable').DataTable().ajax.reload();
});

function formatFileSize(bytes) {
    if (bytes === 0)
        return '0 Bytes';

    const sizes = [
        'Bytes',
        'KB',
        'MB',
        'GB',
        'TB',
        'PB'
    ];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = (bytes / Math.pow(1024, i)).toFixed(2);

    return `${value} ${sizes[i]}`;
}

function downloadFiles(filePaths) {
    filePaths.forEach(filePath => {
        console.log(filePath);

        // Adjust path for use in href by replacing backslashes
        const adjustedPath = filePath.startsWith('/')
            ? filePath
            : '/' + filePath;

        // Create a temporary link element for download
        const link = document.createElement('a');
        link.href = adjustedPath.replace('C:/', ''); // Set href
        link.download = adjustedPath
            .split('/')
            .pop(); // Extract filename
        document
            .body
            .appendChild(link);

        // Trigger the download
        link.click();

        // Clean up the link element
        document
            .body
            .removeChild(link);
    });
}