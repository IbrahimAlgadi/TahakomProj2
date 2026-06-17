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
var kashifResponsePercentageChart = echarts.init(document.getElementById('kashifResponsePercentage'));
var kashifWantedStatusCodeChart = echarts.init(document.getElementById('kashifWantedStatusCode'));
var kashifLegalStatusCodeChart = echarts.init(document.getElementById('kashifLegalStatusCode'));

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
    getCorrectFaultTotalReport(startDateFilter, endDateFilter);
    getWantedStatusCode(startDateFilter, endDateFilter);
    getLegalStatusCode(startDateFilter, endDateFilter);
});


// /statistics/wantedStatusCode
// /statistics/legalStatusCode


function getCorrectFaultTotalReport(startDate, endDate) {
    $.ajax({
        url: `/statistics/correct_fault_total_responses`,
        type: 'GET', // Assuming the endpoint expects a GET request
        data: {
            startDate: startDate,
            endDate: endDate
        },
        success: function (response) {
            // Handle the successful response here
            let totalResponses = parseFloat(response.total_responses);
            let correctResponses = parseFloat(response.correct_responses);
            let faultyResponses = parseFloat(response.faulty_responses);
            // Percentage calculation
            // let totalCorrectPercentage = ((correctResponses / totalResponses) * 100).toFixed(2);
            // let totalFaultPercentage = ((faultyResponses / totalResponses) * 100).toFixed(2);
            // Render the data
            $('#totalKashifResponse').html(totalResponses);
            $('#totalCorrectKashifResponse').html(correctResponses);
            $('#totalFaultKashifResponse').html(faultyResponses);
            // console.log('Response:', response);
            renderKashifResponsePercentageChart({totalCorrect: correctResponses, totalWrong: faultyResponses});
        },
        error: function (xhr, status, error) {
            // Handle errors here
            console.error('Error:', status, error);
        }
    });
}

function renderKashifResponsePercentageChart(echartsData) {
    return new Promise((resolve, reject) => {

        // ECharts configuration
        let totalPlates = echartsData.totalCorrect + echartsData.totalWrong;
        var option = option = {
            title: {
                text: 'Kashif Responses'
            },
            toolbox: {
                show: true,
                feature: {
                    saveAsImage: {}
                }
            },
            tooltip: {
                trigger: 'item'
            },
            legend: {
                // top: '5%',
                // itemGap: 5,
                orient: 'vertical',
                align: 'left',
                left: 'center',
            },
            series: [
                {
                    name: 'Responses',
                    type: 'pie',
                    radius: ['40%', '70%'],
                    // center: ['50%', '70%'],
                    // adjust the start angle
                    // startAngle: 180,
                    label: {
                        show: true,
                        formatter(param) {
                            // correct the percentage
                            console.log(param.data);
                            return param.name + ' (' + ((param.data.value / totalPlates) * 100).toFixed(2) + '%)';
                        }
                    },
                    emphasis: {
                        label: {
                            show: true,
                            // fontSize: 40,
                            fontWeight: 'bold'
                        }
                    },
                    data: [
                        {
                            name: 'Total Completed',
                            value: echartsData.totalWrong,
                            itemStyle: {
                                color: '#a90000'
                            },
                        },
                        {
                            name: 'Total Not Completed',
                            value: echartsData.totalCorrect,
                            itemStyle: {
                                color: '#47ec21'
                            },
                        },
                    ]
                }
            ]
        };

        // Set the ECharts options
        kashifResponsePercentageChart.setOption(option);

        resolve("Rendered");
    });
}

function renderKashifWantedStatusCodeChart(echartsData) {
    return new Promise((resolve, reject) => {

        let renderLabels = [];
        let renderDataValues = _.map(echartsData, (obj) => {
            let wantedStatus = vehicleWantedStatusMapping[obj.vehicle_wanted_status_code];
            renderLabels.push(wantedStatus.message);
            return {
                value: obj.total,
                itemStyle: {
                    color: wantedStatus.color
                }
            }
        });

        // ECharts configuration
        let option = {
            title: {
                text: 'Wanted Status'
            },
            tooltip: {
                trigger: 'item'
            },
            toolbox: {
                show: true,
                feature: {
                    saveAsImage: {}
                }
            },
            legend: {
                // data: renderLabels,
                itemGap: 5,
                orient: 'vertical',
                align: 'left',
                left: 'center',
            },
            xAxis: {
                type: 'category',
                data: renderLabels,
                axisLabel: {
                    show: true,
                    interval: 0,
                    rotate: 10,
                },
                axisTick: {
                    show: true,
                    interval: 0
                }
            },
            yAxis: {
                type: 'value'
            },
            series: [
                {
                    data: renderDataValues,
                    type: 'bar',
                    label: {
                        show: true,
                        position: 'top',
                        valueAnimation: true
                    },
                    emphasis: {
                        label: {
                            show: true,
                            // fontSize: 40,
                            fontWeight: 'bold'
                        }
                    },
                }
            ]
        };

        // Set the ECharts options
        kashifWantedStatusCodeChart.setOption(option);

        resolve("Rendered");
    });
}

function getWantedStatusCode(startDate, endDate) {
    $.ajax({
        url: `/statistics/wantedStatusCode`,
        type: 'GET', // Assuming the endpoint expects a GET request
        data: {
            startDate: startDate,
            endDate: endDate
        },
        success: function (response) {
            console.log('Response:', response);
            renderKashifWantedStatusCodeChart(response);
        },
        error: function (xhr, status, error) {
            // Handle errors here
            console.error('Error:', status, error);
        }
    });
}



function renderKashifLegalStatusCodeChart(echartsData) {
    return new Promise((resolve, reject) => {

        let renderLabels = [];
        let renderDataValues = _.map(echartsData, (obj) => {
            let legalStatus = vehicleLegalStatusMapping[obj.vehicle_legal_status_code];
            renderLabels.push(legalStatus.en_message);
            return {
                value: obj.status_count,
                itemStyle: {
                    color: legalStatus.color
                }
            }
        });

        // ECharts configuration
        let option = {
            title: {
                text: 'Legal Status'
            },
            tooltip: {
                trigger: 'item'
            },
            toolbox: {
                show: true,
                feature: {
                    saveAsImage: {}
                }
            },
            legend: {
                data: renderLabels,
                orient: 'vertical',
                align: 'left',
                left: 'center',
            },
            xAxis: {
                type: 'category',
                data: renderLabels,
                axisLabel: {
                    show: true,
                    interval: 0,
                    rotate: 20,
                },
                axisTick: {
                    show: true,
                    interval: 0
                }
            },
            yAxis: {
                type: 'value'
            },
            series: [
                {
                    data: renderDataValues,
                    type: 'bar',
                    label: {
                        show: true,
                        position: 'top',
                        valueAnimation: true
                    },
                    emphasis: {
                        label: {
                            show: true,
                            // fontSize: 40,
                            fontWeight: 'bold'
                        }
                    },
                }
            ]
        };

        // Set the ECharts options
        kashifLegalStatusCodeChart.setOption(option);

        resolve("Rendered");
    });
}

function getLegalStatusCode(startDate, endDate) {
    $.ajax({
        url: `/statistics/legalStatusCode`,
        type: 'GET', // Assuming the endpoint expects a GET request
        data: {
            startDate: startDate,
            endDate: endDate
        },
        success: function (response) {
            console.log('Response:', response);
            renderKashifLegalStatusCodeChart(response);
        },
        error: function (xhr, status, error) {
            // Handle errors here
            console.error('Error:', status, error);
        }
    });
}

$('#exportExcel').click(() => {
    table.download("xlsx", "export.xlsx", {sheetName: "Kashif Export"});
});