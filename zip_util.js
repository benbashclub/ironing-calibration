//##############################################################################
// Name: zip_util.js
// Description: Reads and writes the zip archive inside a 3MF file.
// Author: benbashclub
// Date: November 18, 2026
//
// A 3MF file is a zip archive full of XML files. These functions take files
// out of a zip and pack files into a new one. The browser does the
// compression itself, so no outside library is needed.
//
// Reads zip files that are:
//   - compressed with deflate (the normal kind)
//   - stored with no compression
//   - ZIP64 (the format used for very large archives)
//
// Returns:
//   read_zip         the list of files in an archive
//   read_zip_entry   one file's bytes, or null when the archive doesn't have it
//   write_zip        the bytes of a new archive
//   make_error       an error with a short code the page turns into a message
//
// Usage:
//   const zip = read_zip(buffer);
//   const model = await read_zip_entry(zip, '3D/3dmodel.model');
//   const bytes = await write_zip([{ name: 'notes.txt', data: 'hello' }]);
//
// Integration with other scripts:
//   Load it before the converter, which uses all four functions:
//   <script src="zip_util.js"></script>
//   <script src="ironing_converter.js"></script>
//##############################################################################

'use strict';

// Signatures that start each kind of zip record
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_RECORD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

// Compression methods
const STORED = 0;
const DEFLATED = 8;

// Lookup table for the CRC-32 checksum that every zip entry carries
const CRC_TABLE = make_crc_table();

// Make an error with a short code the page can turn into a plain-English message
function make_error(code, detail) {
    const error = new Error(detail ? `${code}: ${detail}` : code);
    error.code = code;
    error.detail = detail || '';
    return error;
}

// Build the CRC-32 lookup table
function make_crc_table() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
}

// Work out the CRC-32 checksum of some bytes
function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

// Run bytes through one of the browser's compress or decompress streams
async function pipe_bytes(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Read the list of files from the zip's central directory
function read_zip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // Find the end record, searching back from the end of the file
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (view.getUint32(i, true) === END_RECORD_SIGNATURE) {
            end = i;
            break;
        }
    }
    if (end < 0) throw make_error('not-zip');

    // Get the number of files and where the central directory starts
    let count = view.getUint16(end + 10, true);
    let directory = view.getUint32(end + 16, true);

    // Very large archives keep those two numbers in a ZIP64 record instead
    if (directory === 0xffffffff || count === 0xffff) {
        const locator = end - 20;
        if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) throw make_error('not-zip');
        const zip64_end = Number(view.getBigUint64(locator + 8, true));
        count = Number(view.getBigUint64(zip64_end + 32, true));
        directory = Number(view.getBigUint64(zip64_end + 48, true));
    }

    // Read each file's name, compression method, size and where its data is
    const entries = new Map();
    const decoder = new TextDecoder();
    let p = directory;
    for (let n = 0; n < count; n++) {
        if (view.getUint32(p, true) !== CENTRAL_HEADER_SIGNATURE) throw make_error('not-zip');
        const method = view.getUint16(p + 10, true);
        let compressed_size = view.getUint32(p + 20, true);
        let size = view.getUint32(p + 24, true);
        const name_length = view.getUint16(p + 28, true);
        const extra_length = view.getUint16(p + 30, true);
        const comment_length = view.getUint16(p + 32, true);
        let local_header = view.getUint32(p + 42, true);
        const name = decoder.decode(bytes.subarray(p + 46, p + 46 + name_length));

        // ZIP64 files keep their real sizes and data offset in an extra field
        const extra_end = p + 46 + name_length + extra_length;
        for (let e = p + 46 + name_length; e + 4 <= extra_end;) {
            const field_id = view.getUint16(e, true);
            const field_length = view.getUint16(e + 2, true);
            if (field_id === 0x0001) {
                let q = e + 4;
                if (size === 0xffffffff) { size = Number(view.getBigUint64(q, true)); q += 8; }
                if (compressed_size === 0xffffffff) { compressed_size = Number(view.getBigUint64(q, true)); q += 8; }
                if (local_header === 0xffffffff) { local_header = Number(view.getBigUint64(q, true)); q += 8; }
            }
            e += 4 + field_length;
        }

        // Some zip programs write Windows backslashes in names
        entries.set(name.replace(/\\/g, '/'), { method, compressed_size, local_header });
        p += 46 + name_length + extra_length + comment_length;
    }
    return { bytes, view, entries };
}

// Get one file's bytes out of the zip, or null when the zip doesn't have it
async function read_zip_entry(zip, name) {
    const key = name.replace(/^\/+/, '');
    let entry = zip.entries.get(key);

    // File names inside a 3MF ignore upper and lower case, so try that too
    if (!entry) {
        for (const [entry_name, value] of zip.entries) {
            if (entry_name.toLowerCase() === key.toLowerCase()) {
                entry = value;
                break;
            }
        }
    }
    if (!entry) return null;

    // Skip over the file's local header to reach its data
    const { bytes, view } = zip;
    if (view.getUint32(entry.local_header, true) !== LOCAL_HEADER_SIGNATURE) throw make_error('not-zip');
    const start = entry.local_header + 30 +
        view.getUint16(entry.local_header + 26, true) + view.getUint16(entry.local_header + 28, true);
    const data = bytes.subarray(start, start + entry.compressed_size);

    // Stored data is used as it is, and deflated data is unpacked
    if (entry.method === STORED) return data;
    if (entry.method === DEFLATED) return pipe_bytes(data, new DecompressionStream('deflate-raw'));
    throw make_error('unsupported-compression');
}

// Pack files into a new zip archive
async function write_zip(files) {
    const encoder = new TextEncoder();

    // Stamp every file with the current time, in the zip's own (DOS) format
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const chunks = [];
    const directory = [];
    let offset = 0;
    for (const file of files) {
        const name = encoder.encode(file.name);
        const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
        const crc = crc32(data);

        // Compress the file, but store it as it is when that is smaller
        let body = await pipe_bytes(data, new CompressionStream('deflate-raw'));
        let method = DEFLATED;
        if (body.length >= data.length) {
            body = data;
            method = STORED;
        }

        // Local header, followed by the name and the data
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);
        local.setUint16(8, method, true);
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, body.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        chunks.push(new Uint8Array(local.buffer), name, body);

        // Central directory record for the same file
        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        central.setUint16(8, 0x0800, true);
        central.setUint16(10, method, true);
        central.setUint16(12, time, true);
        central.setUint16(14, date, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, body.length, true);
        central.setUint32(24, data.length, true);
        central.setUint16(28, name.length, true);
        central.setUint32(42, offset, true);
        directory.push(new Uint8Array(central.buffer), name);

        offset += 30 + name.length + body.length;
    }

    // End record: how many files there are and where the central directory is
    let directory_size = 0;
    for (const part of directory) directory_size += part.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, END_RECORD_SIGNATURE, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, directory_size, true);
    end.setUint32(16, offset, true);

    // Join everything into one block of bytes
    const parts = [...chunks, ...directory, new Uint8Array(end.buffer)];
    let total = 0;
    for (const part of parts) total += part.length;
    const output = new Uint8Array(total);
    let position = 0;
    for (const part of parts) {
        output.set(part, position);
        position += part.length;
    }
    return output;
}
