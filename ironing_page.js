//##############################################################################
// Ironing Calibration Converter - Version 2
//##############################################################################
// AUTHOR: benbashclub
// DATE: 11/19/2026
//
// DESCRIPTION:
//   Runs the converter page. It takes the 3MF from the Customizable Ironing
//   Calibration customizer on MakerWorld, shows its pads, and saves a new 3MF
//   where every pad already has its own ironing flow and speed. Everything
//   runs in the browser, so the file is never uploaded anywhere.
//
// USAGE:
//   Open index.html, then drop the customizer's 3MF on the drop box.
//
// EXAMPLES:
//   Drop ironing_test.3mf   ->  saves ironing_test-ironing.3mf
//   Drop ironing_test.stl   ->  saves ironing_test-ironing.3mf
//
// PAGE OPTIONS:
//   Slicer                  OrcaSlicer, or Bambu Studio (beta)
//   Ironing line spacing    0.05 to 1 mm (default 0.15)
//   Ironing inset           0 to 2 mm (default 0.21)
//   Ironing angle           fixed angle, OrcaSlicer only (default 0)
//   The three ironing settings sit under "Advanced settings".
//
// FEATURES:
//   - Reads the code under each pad, so no values are typed in
//   - Shows every pad with its flow and speed before saving
//   - Refuses a file when any pad can't be read
//   - A ? next to each advanced setting opens a short help box
//
// REQUIREMENTS:
//   A current version of Chrome, Edge, Firefox or Safari (16.4 or newer).
//   Needs zip_util.js and ironing_converter.js loaded first.
//##############################################################################

'use strict';

// Messages for problems reading a file
const LOAD_ERRORS = {
    'not-supported': "❌ That file isn't a 3MF or STL.",
    'not-zip': "❌ That file isn't a valid 3MF.",
    'bad-3mf': "❌ That 3MF couldn't be read. Try downloading it from MakerWorld again.",
    'unsupported-compression': "❌ That 3MF is packed in a way this page can't read. Try downloading it again.",
    'no-pads': '❌ No calibration pads found. This page only reads files from the ' +
        'Customizable Ironing Calibration on MakerWorld.',
};

// Messages for advanced settings that are out of range
const OPTION_ERRORS = {
    spacing: '❌ Ironing line spacing must be 0.05–1 mm.',
    inset: '❌ Ironing inset must be 0–2 mm.',
    angle: '❌ Ironing angle must be between -360 and 360.',
};

// Slicer names as shown on the page
const SLICER_NAMES = { orca: 'OrcaSlicer', bambu: 'Bambu Studio' };

// The file that was read last, and the link to the last file saved
let CURRENT_FILE = null;
let SAVED_URL = null;

// Function to get a page element by its id
function get_element(id) {
    return document.getElementById(id);
}

// Function to show a status line (kind is 'ok', 'bad' or left out)
function show_status(id, text, kind) {
    const element = get_element(id);
    element.textContent = text || '';
    element.className = 'message' + (kind ? ' ' + kind : '');
}

// Function to write a list of values as a range, e.g. "10–30%"
function format_range(values, unit) {
    if (!values.length) return '';
    const low = format_value(values[0]);
    const high = format_value(values[values.length - 1]);
    return (low === high ? low : low + '–' + high) + unit;
}

// Function to draw the pads as seen from above, each with its flow and speed
function draw_pad_grid(analysis) {
    const [x0, y0, x1, y1] = analysis.bounds;
    const margin = 3;
    const width = x1 - x0 + 2 * margin;
    const height = y1 - y0 + 2 * margin;

    let shapes = '';
    for (const pad of analysis.pads) {
        // Flip top to bottom, so the back of the plate is at the top
        const x = pad.centre_x - pad.width / 2 - x0 + margin;
        const y = y1 - (pad.centre_y + pad.depth / 2) + margin;

        // A pad that couldn't be read is drawn in red with a question mark
        const fill = pad.ok ? 'var(--pad)' : 'var(--bad-soft)';
        const edge = pad.ok ? 'var(--pad-edge)' : 'var(--bad)';
        const top_line = pad.ok ? format_value(pad.flow) + '%' : '?';
        const bottom_line = pad.ok ? format_value(pad.speed) + ' mm/s' : "can't read";
        const big = pad.width * 0.2;
        const small = pad.width * 0.13;

        shapes += `<g><title>${pad.name}${pad.ok ? '' : ': ' + pad.error}</title>` +
            `<rect x="${x}" y="${y}" width="${pad.width}" height="${pad.depth}" rx="${pad.width * 0.07}" ` +
            `style="fill:${fill};stroke:${edge};stroke-width:${pad.width * 0.02}"/>` +
            `<text x="${x + pad.width / 2}" y="${y + pad.depth * 0.46}" text-anchor="middle" ` +
            `style="font-size:${big}px;font-weight:700;fill:var(--ink)">${top_line}</text>` +
            `<text x="${x + pad.width / 2}" y="${y + pad.depth * 0.46 + small * 1.6}" text-anchor="middle" ` +
            `style="font-size:${small}px;fill:var(--muted)">${bottom_line}</text></g>`;
    }
    get_element('pad_grid').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" ` +
        `aria-label="Pads as seen from above, each with its ironing flow and speed">${shapes}</svg>`;
}

// Function to show the pads that were read and open the save step
function show_pads(analysis, file_name) {
    const unreadable = analysis.pads.filter((pad) => !pad.ok).length;
    if (unreadable) {
        show_status('load_message', `❌ ${unreadable} of ${analysis.pads.length} pads couldn't be read, so ` +
            "this file can't be converted. Download it from MakerWorld again.", 'bad');
    } else {
        show_status('load_message', `✅ ${file_name}: all ${analysis.pads.length} pads read.`, 'ok');
    }

    // One line about the grid: its size, flow range, speed range and pad size
    const shape = analysis.is_regular
        ? `${analysis.column_count} × ${analysis.row_count} pads`
        : `${analysis.pads.length} pads`;
    get_element('pad_summary').textContent = `${shape} · flow ${format_range(analysis.flows, '%')} · ` +
        `speed ${format_range(analysis.speeds, ' mm/s')} · ${format_value(analysis.pad_size)} mm pads`;

    // Draw the pads and show the next two steps
    draw_pad_grid(analysis);
    get_element('pads_card').hidden = false;
    get_element('save_card').hidden = false;
    get_element('save_button').disabled = unreadable > 0;
}

// Function to read a dropped or chosen file
async function load_file(file) {
    if (!file) return;

    // Clear the last file before reading the new one
    CURRENT_FILE = null;
    get_element('pads_card').hidden = true;
    get_element('save_card').hidden = true;
    show_status('save_message', '');
    show_status('load_message', `🔄 Reading ${file.name}…`);

    try {
        const analysis = await read_ironing_file(await file.arrayBuffer(), file.name);
        CURRENT_FILE = { analysis, name: file.name };
        show_pads(analysis, file.name);
    } catch (error) {
        console.error(error);
        show_status('load_message', LOAD_ERRORS[error.code] || `❌ Something went wrong: ${error.message}`, 'bad');
    }
}

// Function to show or hide the angle setting, which only OrcaSlicer has
function update_slicer_notes() {
    const is_orca = get_element('slicer').value === 'orca';
    get_element('angle_field').hidden = !is_orca;
    get_element('angle_note').textContent = is_orca
        ? 'Fixed ironing angle: on, so every pad is ironed in the same direction.'
        : "Bambu Studio has no fixed ironing angle, so your profile's ironing direction is used for every pad.";
}

// Function to free the link to the last saved file
function cleanup_download() {
    if (SAVED_URL) URL.revokeObjectURL(SAVED_URL);
    SAVED_URL = null;
}

// Function to hand the new 3MF to the browser as a download
function save_download(bytes, file_name) {
    cleanup_download();
    SAVED_URL = URL.createObjectURL(new Blob([bytes], { type: 'model/3mf' }));

    // Click a hidden link to start the download
    const link = document.createElement('a');
    link.href = SAVED_URL;
    link.download = file_name;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

// Function to build the new 3MF from the pads and save it
async function build_and_save() {
    if (!CURRENT_FILE) return;
    const button = get_element('save_button');
    button.disabled = true;
    show_status('save_message', '🔄 Building…');

    try {
        const slicer = get_element('slicer').value;
        const bytes = await build_ironing_3mf(CURRENT_FILE.analysis, {
            slicer,
            spacing: get_element('spacing').value,
            inset: get_element('inset').value,
            angle: get_element('angle').value,
        });

        // Name the new file after the old one: test.3mf becomes test-ironing.3mf
        const file_name = CURRENT_FILE.name.replace(/\.(3mf|stl)$/i, '') + '-ironing.3mf';
        save_download(bytes, file_name);
        show_status('save_message', `✅ Saved ${file_name}. Open it in ${SLICER_NAMES[slicer]}.`, 'ok');
    } catch (error) {
        console.error(error);
        if (error.code === 'bad-option') {
            // Open the advanced settings, so the value that needs fixing can be seen
            get_element('advanced').open = true;
            show_status('save_message', OPTION_ERRORS[error.detail], 'bad');
        } else {
            show_status('save_message', `❌ Couldn't build the file: ${error.message}`, 'bad');
        }
    } finally {
        button.disabled = !CURRENT_FILE || CURRENT_FILE.analysis.pads.some((pad) => !pad.ok);
    }
}

// Function to open the help box named by a ? button
function open_help(button) {
    get_element(button.dataset.help).showModal();
}

// Function to close a help box when the dark area around it is clicked
function close_help_on_backdrop(event) {
    const box = event.currentTarget;

    // Clicks on the text or the x belong to the box's contents, not the backdrop
    if (event.target !== box) return;
    const r = box.getBoundingClientRect();
    const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) box.close();
}

// Function to check that this browser can do everything the page needs
function check_requirements() {
    const missing_features = [];

    // Reading and writing 3MF files needs the browser's own zip compression
    if (typeof DecompressionStream === 'undefined') missing_features.push('DecompressionStream');
    if (typeof CompressionStream === 'undefined') missing_features.push('CompressionStream');
    if (!missing_features.length) {
        try {
            new DecompressionStream('deflate-raw');
            new CompressionStream('deflate-raw');
        } catch {
            missing_features.push('deflate-raw compression');
        }
    }
    if (!missing_features.length) return true;

    // Say what is missing and how to fix it
    show_status('load_message', `❌ This browser can't run the converter (missing ${missing_features.join(', ')}). ` +
        'Please use a current version of Chrome, Edge, Firefox or Safari.', 'bad');
    return false;
}

// Function to connect the drop box, the settings and the save button
function main() {
    const drop_zone = get_element('drop_zone');
    const file_input = get_element('file_input');

    // Stop here if the browser is too old to convert files
    if (!check_requirements()) {
        drop_zone.classList.add('disabled');
        file_input.disabled = true;
        return;
    }

    // Read a chosen file straight away. Clearing the input lets the same file be chosen again.
    file_input.addEventListener('change', () => {
        load_file(file_input.files[0]);
        file_input.value = '';
    });

    // Enter or Space on the drop box opens the file chooser
    drop_zone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            file_input.click();
        }
    });

    // Light up the drop box while a file is dragged over it
    for (const type of ['dragenter', 'dragover']) {
        drop_zone.addEventListener(type, (event) => {
            event.preventDefault();
            drop_zone.classList.add('over');
        });
    }
    for (const type of ['dragleave', 'drop']) {
        drop_zone.addEventListener(type, () => drop_zone.classList.remove('over'));
    }

    // Read a file dropped on the box
    drop_zone.addEventListener('drop', (event) => {
        event.preventDefault();
        load_file(event.dataTransfer && event.dataTransfer.files[0]);
    });

    // A file dropped beside the box shouldn't make the browser leave the page
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => event.preventDefault());

    // Slicer choice and the save button
    get_element('slicer').addEventListener('change', update_slicer_notes);
    get_element('save_button').addEventListener('click', build_and_save);
    update_slicer_notes();

    // Each ? button opens its help box. The x, Esc, or a click outside closes it.
    for (const button of document.querySelectorAll('button.help')) {
        button.addEventListener('click', () => open_help(button));
    }
    for (const box of document.querySelectorAll('dialog.help_box')) {
        box.querySelector('.close').addEventListener('click', () => box.close());
        box.addEventListener('click', close_help_on_backdrop);
    }
}

main();
