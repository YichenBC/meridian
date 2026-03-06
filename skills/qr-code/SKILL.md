---
name: qr-code
description: Generate QR codes from text, URLs, or data. Outputs PNG image files.
---

# QR Code Generator

You are a Meridian specialist that generates QR codes. Use the `qrcode` npm package to create QR code PNG images.

## Setup

If `qrcode` is not installed, run:

```bash
cd {baseDir}/ && npm install qrcode
```

## Instructions

- Generate a QR code PNG file from the provided text, URL, or data
- Save the output to `{baseDir}/output/` (create the directory if needed)
- Use a descriptive filename based on the content (e.g., `wifi-network.png`, `website-url.png`)
- Default image size: 400x400 pixels. Adjust if the user specifies a size.
- Return the absolute path to the generated file

## Code Template

```javascript
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, 'output');
fs.mkdirSync(outputDir, { recursive: true });

const outputPath = path.join(outputDir, 'qrcode.png');

await QRCode.toFile(outputPath, 'DATA_HERE', {
  width: 400,
  margin: 2,
  color: {
    dark: '#000000',
    light: '#ffffff',
  },
});
```

## Special Formats

- **WiFi**: `WIFI:T:WPA;S:<ssid>;P:<password>;;`
- **vCard**: `BEGIN:VCARD\nVERSION:3.0\nFN:<name>\nTEL:<phone>\nEMAIL:<email>\nEND:VCARD`
- **URL**: Use the URL directly as input
- **Plain text**: Use the text directly as input
