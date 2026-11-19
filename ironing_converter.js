//##############################################################################
// Name: ironing_converter.js
// Description: Reads the pads in a Customizable Ironing Calibration file and
//              writes a 3MF with every pad's ironing flow and speed set.
// Author: benbashclub
// Date: November 18, 2026
//
// The MakerWorld customizer cuts a tiny code into the underside of every pad,
// under its label strip. The code holds that pad's ironing flow and speed.
// This script finds each pad, reads its code, and writes a new 3MF where the
// grid is one object and each pad is a part with its own ironing flow and
// speed.
//
// Supported input files:
//   - 3MF downloaded from the customizer on MakerWorld
//   - STL exported from the same model (binary or text)
//
// Returns:
//   read_ironing_file   the pads, each with its place, flow and speed
//   build_ironing_3mf   the bytes of the new 3MF
//   format_value        a value rounded for display (12.5, 30)
//
// Usage:
//   const analysis = await read_ironing_file(buffer, 'test.3mf');
//   const bytes = await build_ironing_3mf(analysis,
//       { slicer: 'orca', spacing: 0.15, inset: 0.21, angle: 0 });
//
// OPTIONS:
//   slicer    'orca' (the default) or 'bambu'
//   spacing   ironing line spacing, 0.05 to 1 mm
//   inset     ironing inset, 0 to 2 mm
//   angle     fixed ironing angle, -360 to 360 degrees (OrcaSlicer only)
//
// Integration with other scripts:
//   Needs zip_util.js loaded first. The page (ironing_page.js) calls
//   read_ironing_file when a file is dropped and build_ironing_3mf to save.
//##############################################################################

'use strict';

// Underside code, as cut by customizable_ironing_calibration.scad: a 6 x 6
// grid of squares cut 0.02 mm into the bottom of the pad.
//   - Version 1 (the first downloads): under the middle of the pad, 2 mm pitch
//   - Version 2: under the label strip, 1 mm pitch
// The code is found from its corner markers, so both versions read the same way.
const CODE_DEPTH = 0.02;
const CODE_VERSIONS = [1, 2];

// Each square is 0.6 of the pitch wide, so the whole grid is 5.6 pitches across
const CODE_SQUARE = 0.6;
const CODE_GRID_WIDTH = 5 + CODE_SQUARE;

// Corner squares that are always cut, so the reader can tell which way round
// the pad is. The fourth corner, [5, 5], is never cut.
const CODE_MARKERS = [[0, 0], [5, 0], [0, 5]];

// The other 32 squares hold the data
const CODE_CELLS = list_code_cells();

// A transform that doesn't move anything
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

// Where an STL's pads go: the middle of a 256 mm plate
const STL_PLATE_CENTRE = [128, 128];

// Program names written into the 3MF, so each slicer opens it as its own
const ORCA_APPLICATION = 'OrcaSlicer-2.2.0';
const BAMBU_APPLICATION = 'BambuStudio-02.07.01.57';

// Part transform in the slicer settings: no move
const NO_MOVE_MATRIX = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';

// Fixed file that tells programs what kind of data each file in the 3MF holds
const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '<Default Extension="config" ContentType="text/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '</Types>\n';

// Fixed file that points to the main model file
const RELS_XML = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel-1" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n';


// ==================================================
// Small helpers
// ==================================================

// List the 32 data squares, row by row from the front, left to right in each row
function list_code_cells() {
    const cells = [];
    for (let y = 0; y < 6; y++) {
        for (let x = 0; x < 6; x++) {
            // Skip the four corners
            if ((x === 0 || x === 5) && (y === 0 || y === 5)) continue;
            cells.push([x, y]);
        }
    }
    return cells;
}

// Round to 3 decimals for numbers written into the 3MF
function format_number(value) {
    return String(Math.round(value * 1000) / 1000);
}

// Round to 1 decimal for numbers shown to people
function format_value(value) {
    return String(Math.round(value * 10) / 10);
}

// Round a coordinate to 5 decimals for the 3MF, never writing "-0"
function format_coordinate(value) {
    const rounded = Math.round(value * 1e5) / 1e5;
    return String(rounded === 0 ? 0 : rounded);
}

// Make text safe to put inside XML
function escape_xml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Write one slicer setting as a metadata tag
function metadata_tag(key, value) {
    return `<metadata key="${escape_xml(key)}" value="${escape_xml(value)}"/>`;
}

// Read the name="value" attributes of an XML tag into an object
function read_attributes(text) {
    const attributes = {};
    const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = pattern.exec(text))) {
        attributes[match[1]] = match[2];
    }
    return attributes;
}

// Remove repeated values and sort from low to high
function sorted_unique(values) {
    return [...new Set(values)].sort((a, b) => a - b);
}


// ==================================================
// Transforms
// ==================================================

// Read a 3MF transform: 12 numbers, applied as point * matrix
function read_matrix(text) {
    // No transform means no move
    if (!text) return IDENTITY.slice();

    // A transform that isn't 12 real numbers is treated as no move
    const matrix = text.trim().split(/\s+/).map(Number);
    if (matrix.length !== 12 || !matrix.every(Number.isFinite)) return IDENTITY.slice();
    return matrix;
}

// Combine two transforms: apply a first, then b
function combine_matrices(a, b) {
    const result = new Array(12);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 3; j++) {
            result[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] +
                (i === 3 ? b[9 + j] : 0);
        }
    }
    return result;
}


// ==================================================
// Reading a 3MF
// ==================================================

// Read the vertices and triangles of one 3MF mesh
function read_mesh(body) {
    const vertex_list = [];
    const triangle_list = [];
    let match;

    // Collect every vertex as x, y, z
    const vertex_pattern = /<vertex\b([^>]*)>/g;
    while ((match = vertex_pattern.exec(body))) {
        const attributes = read_attributes(match[1]);
        vertex_list.push(+attributes.x, +attributes.y, +attributes.z);
    }

    // Collect every triangle as the numbers of its three vertices
    const triangle_pattern = /<triangle\b([^>]*)>/g;
    while ((match = triangle_pattern.exec(body))) {
        const attributes = read_attributes(match[1]);
        triangle_list.push(+attributes.v1, +attributes.v2, +attributes.v3);
    }

    // Check that every number is real and every triangle points at a vertex
    const vertices = Float64Array.from(vertex_list);
    const triangles = Uint32Array.from(triangle_list);
    const vertex_count = vertices.length / 3;
    if (!vertices.every(Number.isFinite) || triangle_list.some((v) => !(v >= 0 && v < vertex_count))) {
        throw make_error('bad-3mf');
    }
    return { vertices, triangles };
}

// Read the objects and the build items of one 3MF model file
function read_model(text) {
    const objects = new Map();
    let match;

    // Read each object: its mesh, if it has one, and the components it is made of
    const object_pattern = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    while ((match = object_pattern.exec(text))) {
        const attributes = read_attributes(match[1]);
        const body = match[2];
        const components = [];
        const component_pattern = /<component\b([^>]*)>/g;
        let component;
        while ((component = component_pattern.exec(body))) {
            const component_attributes = read_attributes(component[1]);
            components.push({
                object_id: component_attributes.objectid,
                path: component_attributes['p:path'] || null,
                matrix: read_matrix(component_attributes.transform),
            });
        }
        objects.set(attributes.id, { has_mesh: /<mesh\b/.test(body), body, components });
    }

    // Read the build items: the objects that are placed on the plate
    const items = [];
    const item_pattern = /<item\b([^>]*)>/g;
    while ((match = item_pattern.exec(text))) {
        const attributes = read_attributes(match[1]);
        items.push({ object_id: attributes.objectid, matrix: read_matrix(attributes.transform) });
    }

    // Note which program made the file
    const application = /<metadata\s+name="Application"\s*>([^<]*)<\/metadata>/.exec(text);
    return { objects, items, application: application ? application[1] : '' };
}

// Get one model file out of the 3MF, reading it only the first time
async function get_model_file(files, path) {
    const key = path.replace(/^\/+/, '');
    if (!files.models.has(key)) {
        const bytes = await read_zip_entry(files.zip, key);
        if (!bytes) throw make_error('bad-3mf', `missing ${key}`);
        files.models.set(key, read_model(new TextDecoder().decode(bytes)));
    }
    return files.models.get(key);
}

// Find the main model file, which _rels/.rels points to
async function find_root_model(zip) {
    const rels = await read_zip_entry(zip, '_rels/.rels');
    if (rels) {
        const pattern = /<Relationship\b([^>]*)>/g;
        const text = new TextDecoder().decode(rels);
        let match;
        while ((match = pattern.exec(text))) {
            const attributes = read_attributes(match[1]);
            if (/3dmodel$/.test(attributes.Type || '') && attributes.Target) return attributes.Target;
        }
    }

    // Most 3MF files use the standard name
    return '3D/3dmodel.model';
}

// Follow an object and its components down to their meshes, keeping each
// mesh with the transform that puts it on the plate
async function collect_meshes(files, path, object_id, matrix, depth, meshes) {
    // Stop on files that nest components too deep (or loop back on themselves)
    if (depth > 10) throw make_error('bad-3mf');

    const model = await get_model_file(files, path);
    const object = model.objects.get(object_id);
    if (!object) throw make_error('bad-3mf', `missing object ${object_id}`);

    // Keep this object's own mesh, if it has one
    if (object.has_mesh) meshes.push({ ...read_mesh(object.body), matrix });

    // Then follow each component, moved by its own transform first
    for (const component of object.components) {
        await collect_meshes(files, component.path || path, component.object_id,
            combine_matrices(component.matrix, matrix), depth + 1, meshes);
    }
}

// Load every mesh in a 3MF, placed where it sits on the plate
async function load_3mf(buffer) {
    const files = { zip: read_zip(buffer), models: new Map() };
    const root_path = await find_root_model(files.zip);
    const root = await get_model_file(files, root_path);

    // Walk each build item down to its meshes
    const meshes = [];
    for (const item of root.items) {
        await collect_meshes(files, root_path, item.object_id, item.matrix, 0, meshes);
    }
    return { meshes, application: root.application, source: '3mf' };
}


// ==================================================
// Reading an STL
// ==================================================

// Check whether an STL is binary: its triangle count has to match its size
function is_binary_stl(buffer) {
    const size = buffer.byteLength;
    return size >= 84 && 84 + 50 * new DataView(buffer).getUint32(80, true) === size;
}

// Read the corners of every triangle in a binary STL
function read_binary_stl(buffer) {
    const view = new DataView(buffer);
    const count = view.getUint32(80, true);
    const vertices = new Float64Array(count * 9);

    // Each triangle is 50 bytes: a 12-byte normal, then 3 corners of 3 numbers
    for (let t = 0; t < count; t++) {
        for (let k = 0; k < 9; k++) {
            vertices[9 * t + k] = view.getFloat32(84 + 50 * t + 12 + 4 * k, true);
        }
    }
    return vertices;
}

// Read the corners of every triangle in a text (ASCII) STL
function read_ascii_stl(buffer) {
    const text = new TextDecoder().decode(new Uint8Array(buffer));
    if (!/^\s*solid\b/.test(text)) throw make_error('not-supported');

    // Collect the numbers on every "vertex x y z" line
    const values = [];
    const pattern = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let match;
    while ((match = pattern.exec(text))) {
        values.push(+match[1], +match[2], +match[3]);
    }

    // Every triangle needs 9 real numbers
    if (!values.length || values.length % 9 || !values.every(Number.isFinite)) throw make_error('not-supported');
    return Float64Array.from(values);
}

// Load an STL as one mesh. STL files repeat shared corners, so every
// triangle gets its own three vertices here.
function load_stl(buffer) {
    const vertices = is_binary_stl(buffer) ? read_binary_stl(buffer) : read_ascii_stl(buffer);
    const triangles = new Uint32Array(vertices.length / 3);
    for (let i = 0; i < triangles.length; i++) triangles[i] = i;
    return { meshes: [{ vertices, triangles, matrix: IDENTITY }], application: '', source: 'stl' };
}


// ==================================================
// Finding the pads
// ==================================================

// Move every mesh to where it sits on the plate and put them all in one list
function place_meshes(meshes) {
    // Count the vertices and triangles first, to size the lists
    let vertex_count = 0;
    let triangle_count = 0;
    for (const mesh of meshes) {
        vertex_count += mesh.vertices.length / 3;
        triangle_count += mesh.triangles.length / 3;
    }
    const vertices = new Float64Array(vertex_count * 3);
    const triangles = new Uint32Array(triangle_count * 3);

    let vertex_offset = 0;
    let triangle_offset = 0;
    for (const mesh of meshes) {
        const m = mesh.matrix;

        // Apply the mesh's transform to each vertex
        for (let i = 0; i < mesh.vertices.length; i += 3) {
            const x = mesh.vertices[i], y = mesh.vertices[i + 1], z = mesh.vertices[i + 2];
            vertices[vertex_offset * 3 + i] = x * m[0] + y * m[3] + z * m[6] + m[9];
            vertices[vertex_offset * 3 + i + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
            vertices[vertex_offset * 3 + i + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
        }

        // Point the triangles at their vertices' new place in the list
        for (let i = 0; i < mesh.triangles.length; i++) {
            triangles[triangle_offset * 3 + i] = mesh.triangles[i] + vertex_offset;
        }
        vertex_offset += mesh.vertices.length / 3;
        triangle_offset += mesh.triangles.length / 3;
    }
    return { vertices, triangles };
}

// Join vertices that sit in the same spot (STL files repeat every shared corner)
function weld_vertices(vertices, triangles) {
    const vertex_count = vertices.length / 3;
    const index = new Map();
    const remap = new Uint32Array(vertex_count);
    const welded = [];
    for (let i = 0; i < vertex_count; i++) {
        // Vertices that round to the same 0.0001 mm get the same key
        const key = Math.round(vertices[3 * i] * 1e4) + ',' + Math.round(vertices[3 * i + 1] * 1e4) + ',' +
            Math.round(vertices[3 * i + 2] * 1e4);
        let j = index.get(key);
        if (j === undefined) {
            j = welded.length / 3;
            index.set(key, j);
            welded.push(vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2]);
        }
        remap[i] = j;
    }
    return { vertices: Float64Array.from(welded), triangles: triangles.map((v) => remap[v]) };
}

// Find the group a vertex belongs to
function find_group(parent, a) {
    while (parent[a] !== a) {
        // Point each vertex on the way at its grandparent, to keep later searches short
        parent[a] = parent[parent[a]];
        a = parent[a];
    }
    return a;
}

// Put two vertices in the same group
function join_groups(parent, a, b) {
    const root_a = find_group(parent, a);
    const root_b = find_group(parent, b);
    if (root_a !== root_b) parent[root_b] = root_a;
}

// Split the triangles into groups that touch each other: one group per pad
function group_triangles(triangles, vertex_count) {
    // Start with every vertex in a group of its own
    const parent = new Int32Array(vertex_count);
    for (let i = 0; i < vertex_count; i++) parent[i] = i;

    // Join the three corners of every triangle into one group
    const triangle_count = triangles.length / 3;
    for (let t = 0; t < triangle_count; t++) {
        join_groups(parent, triangles[3 * t], triangles[3 * t + 1]);
        join_groups(parent, triangles[3 * t], triangles[3 * t + 2]);
    }

    // Collect the triangle numbers in each group
    const groups = new Map();
    for (let t = 0; t < triangle_count; t++) {
        const root = find_group(parent, triangles[3 * t]);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(t);
    }
    return [...groups.values()];
}


// ==================================================
// Reading the code under a pad
// ==================================================

// Turn a cell [x, y] a quarter turn
function rotate_cell(cell) {
    return [5 - cell[1], cell[0]];
}

// Give a cell one number, so cells can be kept in a Set
function cell_key(cell) {
    return cell[0] * 6 + cell[1];
}

// Read bits first to last (least significant bit first) as one number
function read_bits(bits, first, last) {
    let value = 0;
    for (let j = 0; j < last - first; j++) {
        value += bits[first + j] * 2 ** j;
    }
    return value;
}

// Read a pad's flow and speed from the squares cut under it
function decode_cells(cells) {
    const matches = [];

    // Try all four ways round. Only one should show the three corner markers.
    for (let turn = 0; turn < 4; turn++) {
        let turned = cells;
        for (let i = 0; i < turn; i++) turned = turned.map(rotate_cell);
        const cut = new Set(turned.map(cell_key));
        const has_markers = CODE_MARKERS.every((marker) => cut.has(cell_key(marker)));
        if (has_markers && !cut.has(cell_key([5, 5]))) matches.push(cut);
    }
    if (matches.length !== 1) return { error: 'no code found under this pad' };

    // Read the 32 data squares as bits: a cut square is a 1
    const cut = matches[0];
    const bits = CODE_CELLS.map((cell) => (cut.has(cell_key(cell)) ? 1 : 0));

    // Split the bits into the four fields
    const version = read_bits(bits, 0, 2);
    const flow10 = read_bits(bits, 2, 12);
    const speed10 = read_bits(bits, 12, 24);
    const check = read_bits(bits, 24, 32);

    // Refuse codes this page doesn't know, and codes that fail their check
    if (!CODE_VERSIONS.includes(version)) return { error: 'code from a newer version of the customizer' };
    if (check !== (31 * version + 7 * flow10 + 13 * speed10 + 90) % 251) return { error: 'code check failed' };
    return { flow: flow10 / 10, speed: speed10 / 10 };
}

// Measure one pad and read the code under it
function read_pad(vertices, triangles, triangle_ids) {
    // Find the pad's bounding box
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const t of triangle_ids) {
        for (let k = 0; k < 3; k++) {
            const v = triangles[3 * t + k];
            const x = vertices[3 * v], y = vertices[3 * v + 1], z = vertices[3 * v + 2];
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            if (z < z0) z0 = z;
            if (z > z1) z1 = z;
        }
    }
    const centre_x = (x0 + x1) / 2;
    const centre_y = (y0 + y1) / 2;

    // Find the code: the ceilings of its squares are flat faces pointing down,
    // CODE_DEPTH above the bottom of the pad
    const code_z = z0 + CODE_DEPTH;
    const code_triangles = [];
    let code_x0 = Infinity, code_y0 = Infinity, code_x1 = -Infinity, code_y1 = -Infinity;
    for (const t of triangle_ids) {
        const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];

        // Only look at flat triangles at the height of the code
        if (Math.abs(vertices[3 * a + 2] - code_z) > 0.004 || Math.abs(vertices[3 * b + 2] - code_z) > 0.004 ||
            Math.abs(vertices[3 * c + 2] - code_z) > 0.004) continue;

        // Only look at faces that point down
        const ux = vertices[3 * b] - vertices[3 * a], uy = vertices[3 * b + 1] - vertices[3 * a + 1];
        const vx = vertices[3 * c] - vertices[3 * a], vy = vertices[3 * c + 1] - vertices[3 * a + 1];
        if (ux * vy - uy * vx >= 0) continue;

        // Keep the triangle, and stretch the code's outline to take it in
        code_triangles.push(t);
        for (const v of [a, b, c]) {
            code_x0 = Math.min(code_x0, vertices[3 * v]);
            code_x1 = Math.max(code_x1, vertices[3 * v]);
            code_y0 = Math.min(code_y0, vertices[3 * v + 1]);
            code_y1 = Math.max(code_y1, vertices[3 * v + 1]);
        }
    }

    // Three corner markers are always cut, so the outline covers the whole grid
    // and its width gives the pitch. An outline that isn't square isn't a code.
    const grid_size = code_x1 - code_x0;
    const pitch = grid_size / CODE_GRID_WIDTH;
    const cells = new Map();
    if (code_triangles.length && Math.abs(code_y1 - code_y0 - grid_size) < 0.05 * grid_size) {
        for (const t of code_triangles) {
            const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];

            // Work out which square of the 6 x 6 grid the triangle is in
            const grid_x = ((vertices[3 * a] + vertices[3 * b] + vertices[3 * c]) / 3 - code_x0) / pitch - CODE_SQUARE / 2;
            const grid_y = ((vertices[3 * a + 1] + vertices[3 * b + 1] + vertices[3 * c + 1]) / 3 - code_y0) / pitch -
                CODE_SQUARE / 2;
            const cell_x = Math.round(grid_x);
            const cell_y = Math.round(grid_y);

            // Keep it only when it sits near the middle of a square inside the grid
            if (Math.abs(grid_x - cell_x) < 0.35 && Math.abs(grid_y - cell_y) < 0.35 &&
                cell_x >= 0 && cell_x <= 5 && cell_y >= 0 && cell_y <= 5) {
                cells.set(cell_x * 6 + cell_y, [cell_x, cell_y]);
            }
        }
    }

    const code = decode_cells([...cells.values()]);
    return {
        centre_x,
        centre_y,
        width: x1 - x0,
        depth: y1 - y0,
        height: z1 - z0,
        bottom_z: z0,
        triangle_ids,
        ok: !code.error,
        ...code,
    };
}

// Name a pad for the slicer's object list, e.g. "Pad 07 · 15% · 35 mm/s"
function name_pad(pad) {
    const number = String(pad.number).padStart(2, '0');
    if (!pad.ok) return `Pad ${number}`;
    return `Pad ${number} · ${format_value(pad.flow)}% · ${format_value(pad.speed)} mm/s`;
}

// Sort the pads into rows from the front of the plate, left to right in each
// row, and number and name them in that order
function number_pads(pads) {
    const rows = [];
    const front_to_back = [...pads].sort((a, b) => a.centre_y - b.centre_y);
    for (const pad of front_to_back) {
        // A pad less than half a pad away from a row's first pad is in that row
        const row = rows[rows.length - 1];
        if (row && Math.abs(pad.centre_y - row[0].centre_y) < row[0].depth / 2) {
            row.push(pad);
        } else {
            rows.push([pad]);
        }
    }

    let number = 0;
    for (let r = 0; r < rows.length; r++) {
        rows[r].sort((a, b) => a.centre_x - b.centre_x);
        for (let c = 0; c < rows[r].length; c++) {
            const pad = rows[r][c];
            number++;
            pad.row = r;
            pad.column = c;
            pad.number = number;
            pad.name = name_pad(pad);
        }
    }
    pads.sort((a, b) => a.number - b.number);
    return rows;
}

// Read a customizer file and return its pads, each with its flow and speed
async function read_ironing_file(buffer, file_name) {
    // Pick the loader: a 3MF is a zip, and every zip starts with the letters "PK"
    const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    const is_zip = head[0] === 0x50 && head[1] === 0x4b;
    let source;
    if (is_zip) {
        source = await load_3mf(buffer);
    } else if (/\.stl$/i.test(file_name || '')) {
        source = load_stl(buffer);
    } else {
        throw make_error('not-supported');
    }
    if (!source.meshes.length) throw make_error('no-pads');

    // Put all the meshes on the plate, join repeated corners, and split into pads
    const placed = place_meshes(source.meshes);
    const welded = weld_vertices(placed.vertices, placed.triangles);
    const groups = group_triangles(welded.triangles, welded.vertices.length / 3);

    // Read the code under each pad
    const pads = [];
    for (const triangle_ids of groups) {
        pads.push(read_pad(welded.vertices, welded.triangles, triangle_ids));
    }
    if (!pads.some((pad) => pad.ok)) throw make_error('no-pads');

    // Number the pads row by row from the front
    const rows = number_pads(pads);

    // Find the outline of the whole grid
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pad of pads) {
        x0 = Math.min(x0, pad.centre_x - pad.width / 2);
        x1 = Math.max(x1, pad.centre_x + pad.width / 2);
        y0 = Math.min(y0, pad.centre_y - pad.depth / 2);
        y1 = Math.max(y1, pad.centre_y + pad.depth / 2);
        z0 = Math.min(z0, pad.bottom_z);
    }

    // A regular grid has the same number of pads in every row
    const column_count = Math.max(...rows.map((row) => row.length));
    const is_regular = rows.every((row) => row.length === column_count);

    // The pad size shown on the page is the middle one of the pads that were read
    const read_pads = pads.filter((pad) => pad.ok);
    const sizes = read_pads.map((pad) => pad.width).sort((a, b) => a - b);

    return {
        source: source.source,
        application: source.application,
        pads,
        vertices: welded.vertices,
        triangles: welded.triangles,
        row_count: rows.length,
        column_count,
        is_regular,
        flows: sorted_unique(read_pads.map((pad) => pad.flow)),
        speeds: sorted_unique(read_pads.map((pad) => pad.speed)),
        pad_size: sizes[sizes.length >> 1],
        bounds: [x0, y0, x1, y1],

        // The object's origin: the middle of the grid, at the bottom of the pads
        origin: [(x0 + x1) / 2, (y0 + y1) / 2, z0],

        // Where the grid goes: a 3MF keeps the place MakerWorld gave it, and
        // an STL goes to the middle of the plate
        place: source.source === 'stl' ? STL_PLATE_CENTRE : [(x0 + x1) / 2, (y0 + y1) / 2],

        title: is_regular
            ? `Ironing calibration ${column_count}x${rows.length}`
            : `Ironing calibration (${pads.length} pads)`,
    };
}


// ==================================================
// Writing the new 3MF
// ==================================================

// Check the shared ironing settings
function check_options(options) {
    const settings = {
        slicer: options.slicer === 'bambu' ? 'bambu' : 'orca',
        spacing: Number(options.spacing),
        inset: Number(options.inset),
        angle: Number(options.angle || 0),
    };
    if (!(settings.spacing >= 0.05 && settings.spacing <= 1)) throw make_error('bad-option', 'spacing');
    if (!(settings.inset >= 0 && settings.inset <= 2)) throw make_error('bad-option', 'inset');
    if (!(settings.angle >= -360 && settings.angle <= 360)) throw make_error('bad-option', 'angle');
    return settings;
}

// Write one pad's mesh, moved so the grid's origin is at 0, 0, 0
function write_pad_mesh(analysis, pad) {
    const local_ids = new Map();
    const vertex_lines = [];
    const triangle_lines = [];
    const [origin_x, origin_y, origin_z] = analysis.origin;
    for (const t of pad.triangle_ids) {
        const ids = [];
        for (let k = 0; k < 3; k++) {
            const v = analysis.triangles[3 * t + k];

            // Give each vertex a number of its own inside this pad's mesh
            let id = local_ids.get(v);
            if (id === undefined) {
                id = local_ids.size;
                local_ids.set(v, id);
                vertex_lines.push(`<vertex x="${format_coordinate(analysis.vertices[3 * v] - origin_x)}" ` +
                    `y="${format_coordinate(analysis.vertices[3 * v + 1] - origin_y)}" ` +
                    `z="${format_coordinate(analysis.vertices[3 * v + 2] - origin_z)}"/>`);
            }
            ids.push(id);
        }
        triangle_lines.push(`<triangle v1="${ids[0]}" v2="${ids[1]}" v3="${ids[2]}"/>`);
    }
    return '<mesh><vertices>\n' + vertex_lines.join('\n') + '\n</vertices><triangles>\n' +
        triangle_lines.join('\n') + '\n</triangles></mesh>';
}

// Write 3D/3dmodel.model: every pad's mesh, and the grid object built from them
function write_model_xml(analysis, settings, grid_id, placement) {
    const objects = [];
    for (let i = 0; i < analysis.pads.length; i++) {
        objects.push(`<object id="${i + 1}" type="model">${write_pad_mesh(analysis, analysis.pads[i])}</object>`);
    }

    // The grid object lists every pad as a component
    let components = '';
    for (let i = 0; i < analysis.pads.length; i++) {
        components += `<component objectid="${i + 1}"/>`;
    }
    objects.push(`<object id="${grid_id}" type="model"><components>${components}</components></object>`);

    const application = settings.slicer === 'bambu' ? BAMBU_APPLICATION : ORCA_APPLICATION;
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
        'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n' +
        `<metadata name="Application">${application}</metadata>\n` +
        '<metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
        `<metadata name="Title">${escape_xml(analysis.title)}</metadata>\n` +
        '<resources>\n' + objects.join('\n') + '\n</resources>\n' +
        `<build>\n<item objectid="${grid_id}" transform="${placement}" printable="1"/>\n</build>\n</model>\n`;
}

// Write Metadata/model_settings.config: the shared ironing settings go on the
// grid object, and each pad's flow and speed go on its own part
function write_config_xml(analysis, settings, grid_id, placement) {
    // Ironing settings shared by every pad
    const shared = [
        ['ironing_type', 'topmost'],
        ['ironing_pattern', 'zig-zag'],
        ['ironing_spacing', format_number(settings.spacing)],
        ['ironing_inset', format_number(settings.inset)],
    ];

    // OrcaSlicer can also fix the ironing angle, so every pad is ironed the same way
    if (settings.slicer === 'orca') {
        shared.push(['ironing_angle', format_number(settings.angle)], ['ironing_angle_fixed', '1']);
    }
    let shared_tags = '';
    for (const [key, value] of shared) shared_tags += metadata_tag(key, value);

    // One part per pad, with its own flow and speed
    let parts = '';
    for (let i = 0; i < analysis.pads.length; i++) {
        const pad = analysis.pads[i];
        parts += `<part id="${i + 1}" subtype="normal_part">` +
            metadata_tag('name', pad.name) +
            metadata_tag('matrix', NO_MOVE_MATRIX) +
            metadata_tag('extruder', '1') +
            metadata_tag('ironing_flow', format_number(pad.flow) + '%') +
            metadata_tag('ironing_speed', format_number(pad.speed)) +
            '</part>';
    }

    return '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
        `<object id="${grid_id}">` + metadata_tag('name', analysis.title) + metadata_tag('extruder', '1') +
        shared_tags + parts + '</object>\n' +
        '<plate>' + metadata_tag('plater_id', '1') + metadata_tag('plater_name', analysis.title) +
        metadata_tag('locked', 'false') +
        '<model_instance>' + metadata_tag('object_id', grid_id) + metadata_tag('instance_id', '0') +
        metadata_tag('identify_id', 1000 + grid_id) + '</model_instance></plate>\n' +
        `<assemble><assemble_item object_id="${grid_id}" instance_id="0" transform="${placement}" ` +
        'offset="0 0 0"/></assemble>\n' +
        '</config>\n';
}

// Build the new 3MF: one object for the grid, one part per pad
async function build_ironing_3mf(analysis, options) {
    const settings = check_options(options || {});
    if (analysis.pads.some((pad) => !pad.ok)) throw make_error('unreadable-pads');

    // The grid object comes after the pad meshes, so its id is one past the last pad
    const grid_id = analysis.pads.length + 1;

    // Where the grid sits on the plate
    const placement = `1 0 0 0 1 0 0 0 1 ${format_number(analysis.place[0])} ${format_number(analysis.place[1])} 0`;

    return write_zip([
        { name: '[Content_Types].xml', data: CONTENT_TYPES_XML },
        { name: '_rels/.rels', data: RELS_XML },
        { name: '3D/3dmodel.model', data: write_model_xml(analysis, settings, grid_id, placement) },
        { name: 'Metadata/model_settings.config', data: write_config_xml(analysis, settings, grid_id, placement) },
    ]);
}
