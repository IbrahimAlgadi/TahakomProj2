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
            data: null,
            render: function (data, type, row) {
                // Build a unique, stable gallery ID for this row from its natural key
                const galleryId = 'gal-' +
                    (row.plate_num   || '').replace(/[^a-z0-9]/gi, '') + '-' +
                    (row.date_folder || '').replace(/[^a-z0-9]/gi, '') + '-' +
                    (row.time_folder || '').replace(/[^a-z0-9]/gi, '');

                const links = row.file_names.map((name, i) => {
                    if (row.file_sizes[i] > 0) {
                        const url = row.file_paths[i]
                            .replace(/\\/g, '/')
                            .replace(/^[A-Za-z]:\//, '/');
                        return `<a href="${url}" data-toggle="lightbox" data-gallery="${galleryId}" data-title="${name}" class="d-block text-truncate file-thumb-link" title="${name}">${name}</a>`;
                    }
                    return `<span class="d-block text-truncate text-muted" title="${name}">${name}</span>`;
                });

                return `<div class="file-names-cell">${links.join('')}</div>`;
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
        // Normalise backslashes then strip any Windows drive prefix (C:/, D:/, etc.)
        // so the path becomes a root-relative URL that matches the /export static mount.
        const urlPath = filePath.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '/');

        const link = document.createElement('a');
        link.href = urlPath;
        link.download = urlPath.split('/').pop();
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
}

// ─── Bootstrap 5 image gallery lightbox ──────────────────────────────────────
// Replaces ekko-lightbox (Bootstrap 4 only — incompatible with this project).
// Uses bootstrap.Modal which is already available via bootstrap.bundle.min.js.

let _lbGallery = [];
let _lbIndex   = 0;
let _lbModalEl = null;
let _lbModal   = null;

function _initLightboxModal() {
    if (_lbModalEl) return;

    document.body.insertAdjacentHTML('beforeend', `
        <div class="modal fade" id="imgLightboxModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered modal-xl">
                <div class="modal-content bg-dark border-0">
                    <div class="modal-header border-0 py-2 px-3">
                        <span id="lbTitle" class="modal-title text-white small text-truncate me-2"></span>
                        <button type="button" class="btn-close btn-close-white ms-auto flex-shrink-0" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body p-0 position-relative text-center" style="min-height:200px">
                        <button id="lbPrev" class="btn btn-sm btn-dark position-absolute start-0 top-50 translate-middle-y ms-2" style="z-index:10;opacity:.85;font-size:1.4rem">&#10094;</button>
                        <img id="lbImg" src="" alt="" class="img-fluid" style="max-height:82vh;object-fit:contain">
                        <button id="lbNext" class="btn btn-sm btn-dark position-absolute end-0 top-50 translate-middle-y me-2" style="z-index:10;opacity:.85;font-size:1.4rem">&#10095;</button>
                    </div>
                    <div class="modal-footer border-0 py-1 justify-content-center">
                        <span id="lbCounter" class="text-secondary small"></span>
                    </div>
                </div>
            </div>
        </div>
    `);

    _lbModalEl = document.getElementById('imgLightboxModal');
    _lbModal   = new bootstrap.Modal(_lbModalEl);

    document.getElementById('lbPrev').addEventListener('click', () => _lbNavigate(-1));
    document.getElementById('lbNext').addEventListener('click', () => _lbNavigate(1));

    _lbModalEl.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft')  _lbNavigate(-1);
        if (e.key === 'ArrowRight') _lbNavigate(1);
    });
}

function _lbNavigate(dir) {
    _lbIndex = (_lbIndex + dir + _lbGallery.length) % _lbGallery.length;
    _lbRender();
}

function _lbRender() {
    const item = _lbGallery[_lbIndex];
    document.getElementById('lbImg').src      = item.url;
    document.getElementById('lbTitle').textContent  = item.title || '';
    document.getElementById('lbCounter').textContent = _lbGallery.length > 1
        ? `${_lbIndex + 1} / ${_lbGallery.length}` : '';
    document.getElementById('lbPrev').style.display = _lbGallery.length > 1 ? '' : 'none';
    document.getElementById('lbNext').style.display = _lbGallery.length > 1 ? '' : 'none';
}

// Delegated — survives DataTable row re-renders
$(document).on('click', '[data-toggle="lightbox"]', function (e) {
    e.preventDefault();
    _initLightboxModal();

    const galleryId = $(this).data('gallery');
    if (galleryId) {
        const $items = $(`[data-toggle="lightbox"][data-gallery="${galleryId}"]`);
        _lbGallery = $items.map((_, el) => ({
            url:   el.getAttribute('href'),
            title: el.getAttribute('data-title') || ''
        })).get();
        _lbIndex = $items.index(this);
    } else {
        _lbGallery = [{ url: this.getAttribute('href'), title: this.getAttribute('data-title') || '' }];
        _lbIndex = 0;
    }

    _lbRender();
    _lbModal.show();
});

// ─── Truncation styles for .file-names-cell ──────────────────────────────────
(function () {
    const s = document.createElement('style');
    s.textContent = `
        .file-names-cell { max-width: 340px; overflow: hidden; }
        .file-thumb-link { display: block; max-width: 100%; overflow: hidden;
                           text-overflow: ellipsis; white-space: nowrap; font-size: .82em; }
    `;
    document.head.appendChild(s);
}());