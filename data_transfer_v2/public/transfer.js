let startDay = moment().startOf('day');
let endDay = moment().endOf('day');
let baseUrl = "/transfer/list";
let socket;

function connectWebsocket() {

    socket = new WebSocket(`ws://${location.host}`);

    socket.addEventListener('open', (event) => {
        console.log('WebSocket connection opened:', event);
        socket.send(JSON.stringify({action: 'subscribe', event: 'realtimeDashboard'}));
    });

    socket.addEventListener('message', (event) => {
        
        // $("#databaseResults").waitMe({});

        let data = JSON.parse(event.data);
        console.log(data);
        if (data.event === 'startStorageTransferProgress') {
            console.log(data.data);
            let transferStatus = data.data.success;
            if (transferStatus) {
                console.log(data.data);
                table.setData(data.data.table);
            } else {
                $("#databaseResults").waitMe("hide");
            }
        }
        if (data.event === 'startStorageTransferDone') {
            $("#databaseResults").waitMe("hide")
        }

    });

    socket.addEventListener('close', (event) => {
        $("#databaseResults").waitMe("hide");

        console.log('WebSocket connection closed:', event);
        setTimeout(() => {
            console.log("[*] Trying to reconnect socket");
            // Call function again
            connectWebsocket();
        }, 2000);
    });

}

connectWebsocket();

/*
* {
  "id": 1,
  "file_path": "C:\\export\\1234\\2024-05-24\\16-24-50-194\\1234__24_05_2024_16_24_48_702__LPR Cam2__3592-QTR.png",
  "transferred": false,
  "file_size": 3311041,
  "file_name": "1234__24_05_2024_16_24_48_702__LPR Cam2__3592-QTR.png",
  "site_id": "1234",
  "date": "2024-05-23T20:00:00.000Z",
  "time": "16:24:50.194"
}
* */

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';

    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = (bytes / Math.pow(1024, i)).toFixed(2);

    return `${value} ${sizes[i]}`;
}

var table = new Tabulator("#databaseResults", {
    height: "450px",
    ajaxURL: baseUrl,
    pagination: "local",
    paginationSize: 12,
    layout: "fitColumns",
    paginationSizeSelector: [3, 6, 8, 10, 12, 999999999],
    // rowFormatter: function (row) {
    //     // console.log(row.getData())
    //     vehicle_wanted_status_code = row.getData().vehicle_wanted_status_code
    //     if (vehicle_wanted_status_code) {
    //         row.getElement().style.backgroundColor = vehicleWantedStatusMapping[vehicle_wanted_status_code].color;
    //         row.getElement().style.color = vehicleWantedStatusMapping[vehicle_wanted_status_code].textColor;
    //     }
    // },
    columns: [
        {
            title: "id",
            field: "id",
            width: 100,
        },
        {
            title: "Car Plate",
            field: "car_plate",
            hozAlign: "center",
            width: 100
        },
        {
            title: "Start Date Time",
            field: "start_date",
            hozAlign: "center",
            formatter: function (cell, formatterParams) {
                var rowData = cell.getRow().getData();
                var startDate = rowData.start_date;
                var startTime = rowData.start_time;
                return `${moment.utc(startDate).local().format('DD/MM/YYYY')} ${startTime}`
            }
        },
        {
            title: "Start Date Time",
            field: "end_date",
            hozAlign: "center",
            formatter: function (cell, formatterParams) {
                var rowData = cell.getRow().getData();
                var endDate = rowData.end_date;
                var endTime = rowData.end_time;
                return `${moment.utc(endDate).local().format('DD/MM/YYYY')} ${endTime}`
            }
        },
        {
            title: "Transfer To",
            field: "usb_path",
            hozAlign: "center",
        },
        {
            title: "Transfer Size",
            field: "total_data_size",
            hozAlign: "center",
            formatter: function (cell, formatterParams) {
                var value = cell.getValue();
                if (value) {
                    return formatFileSize(value);
                } else {
                    return "";
                }
            }
        },
        {
            title: "Total Files",
            field: "total_files",
            hozAlign: "center",
        },
        {
            title: "Total Transferred Files",
            field: "total_transferred_files",
            hozAlign: "center",
        },
        {
            title:"Progress", 
            field:"progress", 
            sorter:"number", 
            hozAlign:"left", 
            formatter:"progress", 
            headerSort:false,
            formatter: function (cell, formatterParams) {
                var rowData = cell.getRow().getData();
                var total_files = rowData.total_files;
                var total_transferred_files = rowData.total_transferred_files;
                let percentage = (total_files > 0) ? parseInt((parseFloat(total_transferred_files)/parseFloat(total_files)) * 100) : 100;
                // if (parseInf(total_transferred_files) === parseInt(total_files)) {
                //     $("#databaseResults").waitMe("hide");
                // }
                return `
                <h4 class="text-success">${percentage}%</h4>
                `;
            }
        },
        {
            title: "Action",
            field: "file_path",
            formatter: function (cell, formatterParams) {
                var rowData = cell.getRow().getData();
                var transferJobId = rowData.id;
                var total_files = rowData.total_files;
                var total_transferred_files = rowData.total_transferred_files;
                if (total_files !== total_transferred_files) {
                    // var fileName = rowData.file_name;
                    return `<button class='btn btn-info' onclick='startStorageTransfer(${transferJobId})'>Start Transfer</a>`;
                } else {
                    return `<button class='btn btn-success'>Transfer Done</a>`;
                }
            }
        },
    ],
});

$(document).ready(() => {
    // Date and time picker
    // $('#startDate').val(thisDay.format());
    $('#startDate').datetimepicker({
        icons: { time: 'far fa-clock' },
        format: 'DD/MM/YYYY HH:mm:ss',
    });
    $('#startDateInput').val(startDay.format("DD/MM/YYYY HH:mm:ss"));
    $('#endDate').datetimepicker({
        icons: { time: 'far fa-clock' },
        format: 'DD/MM/YYYY HH:mm:ss',
    });
    $('#endDateInput').val(endDay.format("DD/MM/YYYY HH:mm:ss"));
});

$('#filterForm').submit(function (e) {
    e.preventDefault();
    var values = $(this).serializeArray();
    var formDataObject = {};
    // Convert the form data array into an object
    $.each(values, function (i, field) {
        formDataObject[field.name] = field.value;
    });
    // console.log(formDataObject);
    let startDateFilter = moment($('#startDateInput').val(), "DD/MM/YYYY hh:mm:ss").format("YYYY-MM-DD HH:mm:ss");
    let endDateFilter = moment($('#endDateInput').val(), "DD/MM/YYYY hh:mm:ss").format("YYYY-MM-DD HH:mm:ss");

    // Update the formDataObject with the formatted dates
    formDataObject.startDate = startDateFilter;
    formDataObject.endDate = endDateFilter;
    // console.log(formDataObject);

    $("#databaseResults").waitMe({});

    // Send the data via AJAX
    $.ajax({
        type: 'POST',
        url: '/transfer/create/new',
        data: formDataObject,
        success: function (response) {
            console.log('Transfer started successfully:', response);
            // Handle the success response
            table.setData(baseUrl);
            $("#databaseResults").waitMe("hide");
        },
        error: function (xhr, status, error) {
            console.error('Error starting transfer:', error);
            // Handle the error response
        }
    });
    
});

function startStorageTransfer(transferJobId) {
    // console.log(startDateFilter, endDateFilter);
    $("#databaseResults").waitMe({});

    let params = {
        'transferJobId': transferJobId, 
    }
    // console.log(params);
    socket.send(JSON.stringify({
        'action': 'startStorageTransfer',
        event: "startStorageTransfer",
        params
    }))
}
