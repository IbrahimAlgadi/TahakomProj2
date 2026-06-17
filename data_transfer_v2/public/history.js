// $('#dataTable').DataTable({
//     "paging": true,
//     "lengthChange": true,
//     "searching": true,
//     "ordering": true,
//     "info": true,
//     "autoWidth": false,
//     "responsive": true,
//     "buttons": ["excel", "colvis"]
// }).buttons().container().appendTo('#dataTable_wrapper .col-md-6:eq(0)');
let startDay = moment().startOf('day');
let endDay = moment().endOf('day');

var table = new Tabulator("#databaseResults", {
    height: "450px",
    ajaxURL: `/history/data?pageSize=999999999&startDate=${startDay.format('YYYY-MM-DD HH:mm:ss')}&endDate=${endDay.format('YYYY-MM-DD HH:mm:ss')}`,
    pagination: "local",
    paginationSize: 12,
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
            field: "id"
        },
        {
            title: "Plate Number",
            field: "plate_number",
            hozAlign: "center"
        },
        {
            title: "Plate Type",
            field: "plate_type",
            hozAlign: "center",
            formatter: function (cell, formatterParams) {
                var value = cell.getValue();
                if (value) {
                    return plateTypeCodeMapping[value].en_message;
                } else {
                    return "";
                }
            }
        },
        // {
        //     title: "Transaction Id",
        //     field: "transaction_id",
        //     hozAlign: "center"
        // },
        {
            title: "Code",
            field: "code",
            hozAlign: "center"
        },
        {
            title: "Primary Color",
            field: "vehicle_primary_color",
            hozAlign: "center"
        },
        {
            title: "Secondary Color",
            field: "vehicle_secondary_color",
            hozAlign: "center"
        },
        {
            title: "Maker",
            field: "vehicle_maker",
            hozAlign: "center"
        },
        {
            title: "Model",
            field: "vehicle_model",
            hozAlign: "center"
        },
        {
            title: "Manufacture Year",
            field: "vehicle_manufacture_year",
            hozAlign: "center"
        },
        {
            title: "Wanted Status Code",
            field: "vehicle_wanted_status_code",
            hozAlign: "left",
            formatter: function (cell, formatterParams) {
                var value = cell.getValue();
                if (value) {
                    return `
<i style='color:${vehicleWantedStatusMapping[value].color};' class="nav-icon far fa-circle"></i>
<span style='font-weight:bold;'>
    ${vehicleWantedStatusMapping[value].message}
</span>
                    `;
                    // return vehicleWantedStatusMapping[value].message;
                } else {
                    return "";
                }
            }
        },
        {
            title: "LPR Id",
            field: "lpr_id",
            hozAlign: "center"
        },
        {
            title: "Camera Id",
            field: "camera_id",
            hozAlign: "center"
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
            formatter: function (cell, formatterParams) {
                var value = cell.getValue();
                if (value) {
                    return moment(value, "HH:mm:ss.SSS").format('HH:mm A');
                } else {
                    return "";
                }
            }
        },
        {
            title: "Legal Statuses En",
            field: "legal_statuses_en",
            hozAlign: "left"
        },
        {
            title: "Legal Statuses Ar",
            field: "legal_statuses_ar",
            hozAlign: "right"
        },
    ],
});

$(document).ready(() => {
    // Date and time picker
    // $('#startDate').val(thisDay.format());
    $('#startDate').datetimepicker({
        icons: {time: 'far fa-clock'},
        format: 'DD/MM/YYYY HH:mm:ss',
    });
    $('#startDateInput').val(startDay.format("DD/MM/YYYY HH:mm:ss"));
    $('#endDate').datetimepicker({
        icons: {time: 'far fa-clock'},
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
    table.setData(`/history/data?search=${formDataObject['carPlate']}&&pageSize=999999999&&startDate=${startDateFilter}&endDate=${endDateFilter}`);
});

$('#exportExcel').click(() => {
    table.download("xlsx", "export.xlsx", {sheetName: "Kashif Export"});
});