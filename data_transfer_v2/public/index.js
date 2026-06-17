let startDay = moment().startOf('day');
let endDay = moment().endOf('day');
let baseUrl = "/files/data";

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
    height: "650px",
    ajaxURL: baseUrl + `?pageSize=10&startDate=${startDay.format('YYYY-MM-DD HH:mm:ss')}&endDate=${endDay.format('YYYY-MM-DD HH:mm:ss')}`,
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
            title: "Site ID",
            field: "site_id",
            hozAlign: "center",
            width: 100
        },
        {
            title: "File Name",
            field: "file_name",
            hozAlign: "left",
            widthGrow: 3
        },
        {
            title: "File Size",
            field: "file_size",
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
            title: "Date",
            field: "date",
            hozAlign: "center",
            formatter: function (cell, formatterParams) {
                var value = cell.getValue();
                if (value) {
                    return moment.utc(value).local().format('DD/MM/YYYY');
                } else {
                    return "";
                }
            }
        },
        {
            title: "Time",
            field: "time",
            hozAlign: "center",
            // formatter: function (cell, formatterParams) {
            //     var value = cell.getValue();
            //     if (value) {
            //         return moment(value, "HH:mm:ss.SSS").format('HH:mm:ss.SSS');
            //     } else {
            //         return "";
            //     }
            // }
        },
        {
            title: "Download",
            field: "file_path",
            width: 150,
            formatter: function (cell, formatterParams) {
                var rowData = cell.getRow().getData();
                var filePath = rowData.file_path;
                var fileName = rowData.file_name;

                if (filePath.indexOf("o") > 0) {
                    return `<a href='${filePath.replace(/^C:/, '')}' class='btn btn-info download-btn' download='${fileName}'>Download</a>`;
                } else {
                    return filePath;
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
    // console.log(startDateFilter, endDateFilter);
    table.setData(baseUrl + `?search=${formDataObject['carPlate']}&&pageSize=999999999&&startDate=${startDateFilter}&endDate=${endDateFilter}`);
});
