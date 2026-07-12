const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const { LoadSkiaWeb } = require("@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb");
const {
  getSkiaExports,
  makeOffscreenSurface,
  ImageFormat,
} = require("@shopify/react-native-skia/lib/commonjs/headless");

const root = join(__dirname, "..");

function drawRoundedRect(Skia, canvas, paint, x, y, width, height, radius, color) {
  paint.setColor(Skia.Color(color));
  canvas.drawRRect(Skia.RRectXY(Skia.XYWHRect(x, y, width, height), radius, radius), paint);
}

function drawMark(Skia, canvas, size, monochrome = false) {
  const unit = size / 512;
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  try {
    const back = monochrome ? "#000000" : "#D8C9B5";
    const middle = monochrome ? "#000000" : "#9FAE99";
    const front = monochrome ? "#000000" : "#242321";
    drawRoundedRect(
      Skia,
      canvas,
      paint,
      86 * unit,
      116 * unit,
      272 * unit,
      310 * unit,
      38 * unit,
      back,
    );
    drawRoundedRect(
      Skia,
      canvas,
      paint,
      112 * unit,
      96 * unit,
      272 * unit,
      310 * unit,
      38 * unit,
      middle,
    );
    drawRoundedRect(
      Skia,
      canvas,
      paint,
      138 * unit,
      76 * unit,
      272 * unit,
      310 * unit,
      38 * unit,
      front,
    );

    if (monochrome) return;
    drawRoundedRect(
      Skia,
      canvas,
      paint,
      160 * unit,
      104 * unit,
      228 * unit,
      192 * unit,
      22 * unit,
      "#B4C0C4",
    );
    drawRoundedRect(
      Skia,
      canvas,
      paint,
      166 * unit,
      322 * unit,
      132 * unit,
      10 * unit,
      5 * unit,
      "#F4F0EA",
    );
    drawRoundedRect(
      Skia,
      canvas,
      paint,
      166 * unit,
      342 * unit,
      88 * unit,
      8 * unit,
      4 * unit,
      "#B9B2A8",
    );

    paint.setColor(Skia.Color("#D95D3F"));
    paint.setStrokeWidth(8 * unit);
    paint.setStyle(1);
    const corner = 34 * unit;
    const left = 150 * unit;
    const top = 88 * unit;
    const right = 398 * unit;
    const bottom = 374 * unit;
    canvas.drawLine(left, top + corner, left, top, paint);
    canvas.drawLine(left, top, left + corner, top, paint);
    canvas.drawLine(right - corner, bottom, right, bottom, paint);
    canvas.drawLine(right, bottom, right, bottom - corner, paint);
  } finally {
    paint.dispose();
  }
}

function renderPng(path, size, background, monochrome = false) {
  const { Skia } = getSkiaExports();
  const surface = makeOffscreenSurface(size, size);
  let image = null;
  try {
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color(background));
    drawMark(Skia, canvas, size, monochrome);
    surface.flush();
    image = surface.makeImageSnapshot();
    writeFileSync(path, Buffer.from(image.encodeToBytes(ImageFormat.PNG, 100)));
  } finally {
    image?.dispose();
    surface.dispose();
  }
}

async function main() {
  await LoadSkiaWeb();
  const images = join(root, "assets", "images");
  renderPng(join(images, "icon.png"), 1024, "#F6F1E8");
  renderPng(join(images, "android-icon-foreground.png"), 512, "#00000000");
  renderPng(join(images, "android-icon-monochrome.png"), 432, "#00000000", true);
  renderPng(join(images, "splash-icon.png"), 228, "#00000000");
}

void main();
