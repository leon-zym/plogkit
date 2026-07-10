const fs = require("node:fs");
const path = require("node:path");

const { LoadSkiaWeb } = require("@shopify/react-native-skia/lib/commonjs/web/LoadSkiaWeb");
const {
  getSkiaExports,
  makeOffscreenSurface,
  ImageFormat,
} = require("@shopify/react-native-skia/lib/commonjs/headless");

const root = path.resolve(__dirname, "..");
const fixtureDirectory = path.join(root, "e2e", "fixtures");

function fill(Skia, canvas, paint, hex, rect) {
  paint.setColor(Skia.Color(hex));
  canvas.drawRect(rect, paint);
}

function createFixture(Skia, name, width, height, palette) {
  const surface = makeOffscreenSurface(width, height);
  const canvas = surface.getCanvas();
  const paint = Skia.Paint();

  fill(Skia, canvas, paint, palette.sky, Skia.XYWHRect(0, 0, width, height * 0.58));
  fill(
    Skia,
    canvas,
    paint,
    palette.ground,
    Skia.XYWHRect(0, height * 0.58, width, height * 0.42),
  );
  paint.setColor(Skia.Color(palette.sun));
  canvas.drawCircle(width * 0.73, height * 0.25, Math.min(width, height) * 0.11, paint);
  paint.setColor(Skia.Color(palette.subject));
  canvas.drawCircle(width * 0.38, height * 0.51, Math.min(width, height) * 0.12, paint);
  fill(
    Skia,
    canvas,
    paint,
    palette.subject,
    Skia.XYWHRect(width * 0.25, height * 0.58, width * 0.27, height * 0.31),
  );
  paint.setStyle(1);
  paint.setStrokeWidth(Math.max(8, width * 0.012));
  paint.setColor(Skia.Color(palette.accent));
  canvas.drawLine(width * 0.08, height * 0.92, width * 0.92, height * 0.92, paint);

  const image = surface.makeImageSnapshot();
  const encoded = image.encodeToBytes(ImageFormat.JPEG, 92);
  if (!encoded) throw new Error(`Unable to encode fixture ${name}`);
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  fs.writeFileSync(path.join(fixtureDirectory, name), Buffer.from(encoded));
  image.dispose();
  paint.dispose();
  surface.dispose();
}

async function main() {
  await LoadSkiaWeb();
  const { Skia } = getSkiaExports();
  createFixture(Skia, "portrait.jpg", 900, 1200, {
    sky: "#B7C9D0",
    ground: "#D8C4A7",
    sun: "#F4D06F",
    subject: "#40594C",
    accent: "#D95D3F",
  });
  createFixture(Skia, "landscape.jpg", 1200, 800, {
    sky: "#CAB7CF",
    ground: "#A8B89E",
    sun: "#F5E3B3",
    subject: "#5A4C48",
    accent: "#D95D3F",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
