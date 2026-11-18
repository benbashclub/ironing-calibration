# Ironing Calibration Converter

Sets the ironing flow and speed on every pad of your **Customizable Ironing Calibration** test, so there's nothing to type into your slicer.

**[Open the converter →](https://benbashclub.github.io/ironing-calibration/)**

## How to use it

1. Make your test with the Customizable Ironing Calibration on MakerWorld and download the 3MF.
2. Drop the 3MF on the converter, check the pads, and save the new 3MF.
3. Open it in OrcaSlicer, pick your printer and filament, then slice and print.

Before you slice, turn off **Ironing flow** and **Ironing speed** in your filament's Setting Overrides. If they're ticked, every pad irons the same.

Your file stays on your computer. Nothing is uploaded.

## What's in here

| File | What it does |
| --- | --- |
| `index.html` | The converter page |
| `style.css` | How the page looks |
| `ironing_page.js` | Runs the page: drop box, pad preview, save button |
| `ironing_converter.js` | Reads the pads and writes the new 3MF |
| `zip_util.js` | Reads and writes the zip inside a 3MF |
| `customizable_ironing_calibration.scad` | The MakerWorld customizer that makes the pads |

Made by [BenBashClub](https://makerworld.com/en/@BenBashClub).
