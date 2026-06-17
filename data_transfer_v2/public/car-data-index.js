let socket;

function connectWebsocket() {

    socket = new WebSocket(`ws://${location.host}`);

    socket.addEventListener('open', (event) => {
        console.log('WebSocket connection opened:', event);
    });

    socket.addEventListener('message', (event) => {
        let data = JSON.parse(event.data);
        console.log('Received message:', data);
        // kashifErrorHappened
        if (data.event === "getVehicleLegalStatusDetailInfoByPlate") {
            setCarPlate(data.data.car_plate);
            displayKashifInfo(data.data.kashif_resp);
        }

        if (data.event === "kashifErrorHappened") {
            // $(document).Toasts('create', {
            //     title: 'Kasif Request Error',
            //     body: data.data.error,
            //     fade: true,
            //     autohide: true,
            //     delay: 60000
            // })
            // jSuites.notification({
            //     error: 1,
            //     name: 'Kasif Request Error',
            //     message: data.data.error,
            // });
            new Toast({
                message: data.data.error,
                type: 'danger'
            });
        }
    });

    socket.addEventListener('close', (event) => {
        console.log('WebSocket connection closed:', event);
        setTimeout(() => {
            console.log("[*] Trying to reconnect socket");
            // Call function again
            connectWebsocket();
        }, 2000);
    });

}

connectWebsocket();

function setCarPlate(carPlate) {
    $('#plateNumberShow').html(carPlate);
}

function setVehicleWantedStatusCode(vehicleWantedStatusCode) {
    const bgColorMapping = {
        'red': 'card-danger',
        'yellow': 'card-warning',
        'green': 'card-success',
        'blue': 'card-primary',
        'default': 'bg-theme'
    };
    let classes = [
        'card-danger',
        'card-warning',
        'card-success',
        'card-primary',
        'bg-theme'
    ]
    let wantedStatusMappingTextElement = $('#wantedStatusMappingText');
    let wantedStatusCardElement = $('#wantedStatusCard');
    let codeMapping = vehicleWantedStatusMapping[vehicleWantedStatusCode];
    // console.log("Vehicle Wanted Status: ");
    // console.log(vehicleWantedStatusCode);
    wantedStatusMappingTextElement.html(
        codeMapping.message
    );
    wantedStatusCardElement.removeClass(classes);
    wantedStatusCardElement.addClass(bgColorMapping[codeMapping.color]);
}

function setCarInfo(vehiclePrimaryColor, vehicleSecondaryColor, vehicleMaker, vehicleModel, vehicleManufactureYear) {
    if (vehiclePrimaryColor || vehicleSecondaryColor || vehicleMaker || vehicleModel || vehicleManufactureYear) {
        $('#vehicleSimpleInfoShow').html(`${vehicleMaker} - ${vehicleModel} - ${vehicleManufactureYear}`);
        $('#carInfoTableBody').html(`
<tr>
    <td>Primary Color</td>
    <td>${vehiclePrimaryColor}</td>
</tr>
<tr>
    <td>Secondary Color</td>
    <td>${vehicleSecondaryColor}</td>
</tr>
<tr>
    <td>Maker</td>
    <td>${vehicleMaker}</td>
</tr>
<tr>
    <td>Model</td>
    <td>${vehicleModel}</td>
</tr>
<tr>
    <td>Manufacture Year</td>
    <td>${vehicleManufactureYear}</td>
</tr>
    `);
        $('#carInfoIndicator').html("");
    } else {
        $('#carInfoTableBody').html('');
        $('#carInfoIndicator').html("N/A");
    }
}

function setLegalStatus(vehicleLegalStatusList) {
    const bgColorMapping = {
        'red': 'bg-danger',
        'yellow': 'bg-warning',
        'green': 'bg-success',
        'blue': 'bg-primary',
        'grey': 'bg-gray',
        'default': 'bg-theme'
    };
    let legalStatusTableDataElement = $('#legalStatusTableData');
    //
    $('#totalStatusCodeData').html(vehicleLegalStatusList.length);
    //
    if (vehicleLegalStatusList.length) {
        let statusCodes = '';
        _.map(vehicleLegalStatusList, (statusCode) => {
            let vehicleLegalStatusCode = statusCode['vehicleLegalStatusCode'];
            let vehicleLegalStatusAr = statusCode['vehicleLegalStatusAr'];
            let vehicleLegalStatusEn = statusCode['vehicleLegalStatusEn'];
            let statusMapping = vehicleLegalStatusMapping[vehicleLegalStatusCode];
            let legalBgColor = bgColorMapping[statusMapping.color];
            statusCodes += `
<tr class="${legalBgColor}">
    <td>${vehicleLegalStatusCode}</td>
    <td>${vehicleLegalStatusAr}</td>
    <td>${vehicleLegalStatusEn}</td>
</tr>
            `;
        });
        legalStatusTableDataElement.html(statusCodes);
    } else {
        legalStatusTableDataElement.html('');
    }
}

function displayKashifInfo(kashifResponse) {
    // --------------------------------------------
    // Extract Variables Data
    // --------------------------------------------
    // Car Info
    // let carPlate = kashifResponse['car_plate'];
    let vehiclePrimaryColor = kashifResponse['vechiclePrimaryColor'];
    let vehicleSecondaryColor = kashifResponse['vechicleSecondaryColor'];
    let vehicleMaker = kashifResponse['vehicleMaker'];
    let vehicleModel = kashifResponse['vehicleModel'];
    let vehicleManufactureYear = kashifResponse['vehicleManufactureYear'];
    // Wanted Status Code
    let vehicleWantedStatusCode = kashifResponse['vehicleWantedStatusCode'];
    // Legal Status
    let vehicleLegalStatusList = kashifResponse['vehicleLegalStatus'];

    // --------------------------------------------
    // Display Data
    // --------------------------------------------
    // setCarPlate(carPlate);
    setVehicleWantedStatusCode(vehicleWantedStatusCode);
    setCarInfo(vehiclePrimaryColor, vehicleSecondaryColor, vehicleMaker, vehicleModel, vehicleManufactureYear);
    setLegalStatus(vehicleLegalStatusList);
}