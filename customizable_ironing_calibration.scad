//##############################################################################
// Name: customizable_ironing_calibration.scad
// Description: MakerWorld customizer that makes a grid of ironing test pads.
// Author: benbashclub
// Date: November 19, 2026
//
// Makes separate test pads for dialing in ironing flow (%) and ironing speed
// (mm/s). Each row of pads is one flow and each column is one speed. The
// Start pad gets the start values, and values go up as you move away from it.
//
// Suggested macro tests (also shown in the customizer, under Start pad):
//   - PLA, the defaults: 5 x 5 pads, flow 10-30 %, speed 15-55 mm/s
//   - PETG: the same, but speed 10-30 mm/s (Speed start 10, Speed step 5)
//
// Returns:
//   A grid of pads. Each pad has its flow and speed engraved on a sunken
//   strip, so it can still be read once it's off the plate. Each pad also
//   has a small code cut 0.02 mm into its underside, under the label strip.
//   That's far thinner than any first layer, so no slicer prints it, and it
//   stays clear of the ironed test area.
//
// Usage:
//   Open the model in MakerWorld's Parametric Model Maker, set the Ironing
//   Settings (they start as the PLA macro), then download the 3MF.
//
// Integration with other scripts:
//   Drop the downloaded 3MF on the converter page. It reads the code under
//   each pad and writes that pad's ironing flow and speed into the 3MF:
//   https://benbashclub.github.io/ironing-calibration/
//##############################################################################


/* [Ironing Settings] */

// Suggested macro tests. PLA, the defaults, is 5 Pad Rows and 5 Pad Columns, Flow start 10, Flow step 5, Speed start 15, Speed step 10. For PETG keep those but set Speed start 10 and Speed step 5. The Start pad gets your start values, and values go up as you move away from it. Middle puts the start values in the centre pad.
Start_pad = "Bottom_left"; // [Bottom_left:Bottom left, Bottom_right:Bottom right, Top_left:Top left, Top_right:Top right, Middle:Middle]

// Rows of pads, bottom to top. Each row is one ironing flow.
Pad_Rows = 5; // [1:1:10]

// Ironing flow on the start pad, in %.
Flow_start = 10; // [1:0.5:100]

// How much the flow changes from one row to the next, in %.
Flow_step = 5; // [0.5:0.5:20]

// Columns of pads, left to right. Each column is one ironing speed.
Pad_Columns = 5; // [1:1:10]

// Ironing speed on the start pad, in mm per second.
Speed_start = 15; // [1:1:200]

// How much the speed changes from one column to the next, in mm per second.
Speed_step = 10; // [1:1:50]


/* [Pad size] */

// Width and depth of each pad, in mm. Bigger pads are easier to judge.
Pad_size = 30; // [20:1:50]

// Space between pads, in mm.
Pad_gap = 2; // [1:0.5:10]

// Pad thickness, in mm.
Pad_height = 2; // [1.2:0.2:4]


/* [Hidden] */

// ==================================================
// Pad details
// ==================================================

// Corner rounding of each pad
CORNER_RADIUS = 2;

// Top of the sunken label strip, above the plate
STRIP_HEIGHT = 0.6;

// How deep the numbers are cut into the strip
ENGRAVE_DEPTH = 0.2;

// Depth of the label strip: 11 mm on a 30 mm pad, kept between 7 and 12 mm
STRIP_DEPTH = min(12, max(7, Pad_size * 11 / 30));

// Largest text height
MAX_TEXT_SIZE = 4.2;

// Leave off "mm/s" if keeping it would shrink the speed text below this size
MIN_UNIT_TEXT_SIZE = 3;

// Font for the numbers
FONT = "Liberation Sans:style=Bold";


// ==================================================
// Underside code (read by the converter page)
// ==================================================

// Format version of the code. Version 2 sits under the label strip.
CODE_VERSION = 2;

// Depth of the code squares: keep far below half of any first layer height
CODE_DEPTH = 0.02;

// Size of one code square, in mm. Keep it 0.6 of the pitch: the converter
// works out the pitch from the size of the whole grid.
CODE_CELL = 0.6;

// Distance from one code square's centre to the next, in mm. The whole grid
// is 5.6 mm across, so it fits under the label strip on the smallest pads.
CODE_PITCH = 1.0;

// Middle of the grid. The customizer preview's bed is centred on the origin,
// and MakerWorld centres the exported 3MF on the plate either way.
BED_CENTRE = [0, 0];

// Small overlap, so cuts pass cleanly through faces
EPS = 0.01;

// Smoothness of round edges
$fn = 32;


// ==================================================
// Pad values
// ==================================================

// Round to one decimal, so the engraved label and the code always agree
function round_tenth(v) = round(v * 10) / 10;

// Write a value without a trailing ".0": 12 -> "12", 12.5 -> "12.5"
function format_value(v) = let (r = round_tenth(v)) (r == floor(r)) ? str(floor(r)) : str(r);

// Check a drop-down value, written with an underscore or a space
function is_choice(v, a, b) = v == a || v == b;

// The Ironing Settings, under the names the rest of the file uses
START_PAD   = Start_pad;
PAD_ROWS    = Pad_Rows;
FLOW_START  = Flow_start;
FLOW_STEP   = Flow_step;
PAD_COLUMNS = Pad_Columns;
SPEED_START = Speed_start;
SPEED_STEP  = Speed_step;

// Find where the start pad sits on each axis: "low", "high" or "mid"
ACROSS_FROM =
    (is_choice(START_PAD, "Bottom_right", "Bottom right") ||
     is_choice(START_PAD, "Top_right", "Top right")) ? "high" :
    is_choice(START_PAD, "Middle", "middle") ? "mid" : "low";
UP_FROM =
    (is_choice(START_PAD, "Top_left", "Top left") ||
     is_choice(START_PAD, "Top_right", "Top right")) ? "high" :
    is_choice(START_PAD, "Middle", "middle") ? "mid" : "low";

// Work out the value of pad i on one axis (i = 0 is the left column or the
// bottom row). "mid" puts the start value in the middle pad. With an even
// count, the extra pad goes to the lower flow and the faster speed:
//   flow,  4 rows,    start 20, step 5   ->  10, 15, 20, 25
//   speed, 4 columns, start 30, step 10  ->  20, 30, 40, 50
function pad_value(i, n, start, step, from, extra_high) =
    from == "high" ? start + (n - 1 - i) * step :
    from == "mid"  ? start + (i - (extra_high ? floor((n - 1) / 2)
                                              : floor(n / 2))) * step :
                     start + i * step;

// Flow of each row, bottom to top
FLOWS  = [for (r = [0 : PAD_ROWS - 1])
             round_tenth(pad_value(r, PAD_ROWS, FLOW_START, FLOW_STEP, UP_FROM, false))];

// Speed of each column, left to right
SPEEDS = [for (c = [0 : PAD_COLUMNS - 1])
             round_tenth(pad_value(c, PAD_COLUMNS, SPEED_START, SPEED_STEP, ACROSS_FROM, true))];

// Collect any settings that would give values the slicer can't use
ERRORS = concat(
    min(FLOWS) < 0.5
        ? [str("Lowest flow would be ", format_value(min(FLOWS)), "%."),
           "Raise Flow start or lower Flow step."] : [],
    max(FLOWS) > 100
        ? [str("Highest flow would be ", format_value(max(FLOWS)), "%."),
           "Lower Flow start or Flow step."] : [],
    min(SPEEDS) < 1
        ? [str("Lowest speed would be ", format_value(min(SPEEDS)), " mm/s."),
           "Raise Speed start or lower Speed step."] : [],
    max(SPEEDS) > 400
        ? [str("Highest speed would be ", format_value(max(SPEEDS)), " mm/s."),
           "Lower Speed start or Speed step."] : []
);


// ==================================================
// Label sizing
// ==================================================

// Guess a character's width in Liberation Sans Bold, in units of text size
function glyph_width(ch) =
    (ch == "m" || ch == "%") ? 1.24 :
    (ch == "/" || ch == ".") ? 0.39 :
                               0.78;

// Add up a list of numbers
function sum_list(v, i = 0) = i >= len(v) ? 0 : v[i] + sum_list(v, i + 1);

// Guess the width of a line of text
function text_width(s) = sum_list([for (i = [0 : len(s) - 1]) glyph_width(s[i])]);

// Find the widest label among a list of values
function widest_label(vals, suffix) = max([for (v = vals) text_width(str(format_value(v), suffix))]);

// Usable label width
TEXT_ROOM = Pad_size - 2 * CORNER_RADIUS - 2;

// Largest text that lets the two lines share the strip
TEXT_CAP = min(MAX_TEXT_SIZE, STRIP_DEPTH * 0.34);

// Keep "mm/s" only if the speed text can stay big enough with it
SPEED_UNIT = TEXT_ROOM / widest_label(SPEEDS, "mm/s") >= min(MIN_UNIT_TEXT_SIZE, TEXT_CAP)
                 ? "mm/s" : "";

// One text size per line for the whole grid, so every pad looks the same
FLOW_SIZE  = min(TEXT_CAP, TEXT_ROOM / widest_label(FLOWS, "%"));
SPEED_SIZE = min(TEXT_CAP, TEXT_ROOM / widest_label(SPEEDS, SPEED_UNIT));


// ==================================================
// Underside code
// ==================================================
// A 6 x 6 grid of 0.6 mm squares on a 1 mm pitch, cut 0.02 mm into the
// bottom face. It's centred under the label strip, so it stays clear of the
// ironed test area. (Version 1 put a bigger grid under the middle of the
// pad. The converter reads both.) Cell [x, y] as seen from above:
// x = 0..5 left to right, y = 0..5 front to back.
//
// Corners [0,0], [5,0] and [0,5] are always cut and [5,5] never is, so the
// converter can find the grid and tell which way round the pad is.
//
// The other 32 cells, row by row from the front and left to right in each
// row, hold 32 bits (a cut square is a 1):
//   bits  0-1   format version (2)
//   bits  2-11  ironing flow  x 10   (0.1 % steps)
//   bits 12-23  ironing speed x 10   (0.1 mm/s steps)
//   bits 24-31  check = (31*version + 7*flow10 + 13*speed10 + 90) mod 251
// Each field is stored least significant bit first.

// Turn a number into a list of n bits, least significant bit first
function to_bits(v, n) = [for (j = [0 : n - 1]) floor(v / pow(2, j)) % 2];

// Make the 32 bits for one pad: version, flow, speed and check
function make_code_bits(flow, speed) =
    let (f10 = round(flow * 10),
         s10 = round(speed * 10),
         chk = (31 * CODE_VERSION + 7 * f10 + 13 * s10 + 90) % 251)
    concat(to_bits(CODE_VERSION, 2), to_bits(f10, 10), to_bits(s10, 12), to_bits(chk, 8));

// Corner squares that are always cut
CODE_MARKERS = [[0, 0], [5, 0], [0, 5]];

// The 32 data squares, row by row from the front, left to right in each row
CODE_CELLS   = [for (y = [0 : 5]) for (x = [0 : 5])
                   if (!((x == 0 || x == 5) && (y == 0 || y == 5))) [x, y]];

// Cut the code squares into the bottom of a pad, centred under the label strip
module cut_code_squares(flow, speed) {
    b = make_code_bits(flow, speed);

    // The markers, plus every data square whose bit is a 1
    cut = concat(CODE_MARKERS,
                 [for (k = [0 : len(CODE_CELLS) - 1]) if (b[k] == 1) CODE_CELLS[k]]);
    for (cell = cut)
        translate([Pad_size / 2    + (cell[0] - 2.5) * CODE_PITCH - CODE_CELL / 2,
                   STRIP_DEPTH / 2 + (cell[1] - 2.5) * CODE_PITCH - CODE_CELL / 2,
                   -EPS])
            cube([CODE_CELL, CODE_CELL, CODE_DEPTH + EPS]);
}


// ==================================================
// Geometry
// ==================================================

// Make a flat tile with rounded corners, sitting on the build plate
module make_rounded_tile(w, d, h, r) {
    hull()
        for (x = [r, w - r], y = [r, d - r])
            translate([x, y, 0]) cylinder(h = h, r = r);
}

// Engrave one line of the label into the strip
module engrave_line(txt, size, y) {
    translate([Pad_size / 2, y, STRIP_HEIGHT - ENGRAVE_DEPTH])
        linear_extrude(height = ENGRAVE_DEPTH + EPS)
            text(txt, size = size, font = FONT,
                 halign = "center", valign = "center", $fn = 16);
}

// Make one pad: a tile with a sunken strip along its front edge, the two
// engraved numbers, and the code underneath
module make_pad(flow, speed) {
    difference() {
        make_rounded_tile(Pad_size, Pad_size, Pad_height, CORNER_RADIUS);

        // Cut the sunken label strip
        translate([-EPS, -EPS, STRIP_HEIGHT])
            cube([Pad_size + 2 * EPS, STRIP_DEPTH + EPS, Pad_height]);

        // Engrave the flow, with the speed below it
        engrave_line(str(format_value(flow), "%"),         FLOW_SIZE,  STRIP_DEPTH * 0.71);
        engrave_line(str(format_value(speed), SPEED_UNIT), SPEED_SIZE, STRIP_DEPTH * 0.27);

        // Cut the code into the underside
        cut_code_squares(flow, speed);
    }
}

// Distance from one pad to the next, and the size of the whole grid
PAD_PITCH   = Pad_size + Pad_gap;
GRID_WIDTH  = PAD_COLUMNS * Pad_size + (PAD_COLUMNS - 1) * Pad_gap;
GRID_DEPTH  = PAD_ROWS    * Pad_size + (PAD_ROWS    - 1) * Pad_gap;

// Lay out the pads, centred on the bed
module make_grid() {
    translate([BED_CENTRE[0] - GRID_WIDTH / 2, BED_CENTRE[1] - GRID_DEPTH / 2, 0])
        for (row = [0 : PAD_ROWS - 1], col = [0 : PAD_COLUMNS - 1])
            translate([col * PAD_PITCH, row * PAD_PITCH, 0])
                make_pad(FLOWS[row], SPEEDS[col]);
}

// Show a warning plate instead of the pads when the settings would give
// values the slicer can't use
module show_warning(lines) {
    w = 180;
    line_h = 7;
    d = 26 + line_h * len(lines);
    translate([BED_CENTRE[0] - w / 2, BED_CENTRE[1] - d / 2, 0]) {
        cube([w, d, 1.2]);
        translate([w / 2, d - 11, 1.2])
            linear_extrude(height = 1)
                text("Check your settings", size = 7, font = FONT,
                     halign = "center", valign = "center");
        for (i = [0 : len(lines) - 1])
            translate([w / 2, d - 24 - i * line_h, 1.2])
                linear_extrude(height = 1)
                    text(lines[i], size = 4, font = FONT,
                         halign = "center", valign = "center");
    }
}


// ==================================================
// Build the model
// ==================================================

// Show the warning plate if a setting is out of range, otherwise build the pads
if (len(ERRORS) > 0) {
    show_warning(ERRORS);
    echo(str("CHECK YOUR SETTINGS: ", ERRORS));
} else {
    make_grid();
    echo(str(PAD_COLUMNS * PAD_ROWS, " pads, plate needed ",
             format_value(GRID_WIDTH), " x ", format_value(GRID_DEPTH), " mm"));
    echo(str("Flow ", format_value(min(FLOWS)), " to ", format_value(max(FLOWS)), " %,  ",
             "speed ", format_value(min(SPEEDS)), " to ", format_value(max(SPEEDS)), " mm/s"));
}
